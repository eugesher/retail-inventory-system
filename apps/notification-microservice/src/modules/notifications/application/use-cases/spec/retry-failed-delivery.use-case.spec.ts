import { PinoLogger } from 'nestjs-pino';

import {
  INotificationDeliveryFailedEvent,
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { Notification, NotificationDelivery, NotificationErrorCodeEnum } from '../../../domain';
import { INotificationEventsPublisherPort, INotifierPort } from '../../ports';
import { RetryDeliveryUseCase } from '../retry-delivery.use-case';
import { RetryFailedDeliveriesUseCase } from '../retry-failed-deliveries.use-case';
import { FakeLogger, InMemoryDeliveryRepo } from './test-doubles';

// A notifier whose next send outcome is scripted, so a spec can drive a retry to success
// or another failure deterministically. `sent` records the dispatched notifications (the
// `InMemoryNotifier` shape), `failNext` flips a single send to reject.
class ScriptedNotifier implements INotifierPort {
  public readonly sent: Notification[] = [];
  public shouldFail = false;

  public send(notification: Notification): Promise<void> {
    if (this.shouldFail) {
      return Promise.reject(new Error('SMTP 421 service unavailable'));
    }
    this.sent.push(notification);
    return Promise.resolve();
  }
}

// Records the `notifications.delivery.failed` events the cap path emits, so a spec can
// assert it fires exactly once (and with the right shape).
class RecordingEventsPublisher implements INotificationEventsPublisherPort {
  public readonly published: INotificationDeliveryFailedEvent[] = [];

  public publishDeliveryFailed(event: INotificationDeliveryFailedEvent): Promise<void> {
    this.published.push(event);
    return Promise.resolve();
  }
}

// The two retry paths — manual (`RetryDeliveryUseCase`) and scheduled
// (`RetryFailedDeliveriesUseCase`) — share one re-dispatch + cap-emit step (`reattempt`),
// so the spec exercises both. It proves: a `failed` delivery retried to success / to
// another failure (with `attemptCount` incremented and monotonic); the cap leaves the row
// `failed` and emits `notifications.delivery.failed` once; the sweeper's backoff gate skips
// a too-recent row; and a non-`failed` delivery is a typed
// `DELIVERY_INVALID_STATUS_TRANSITION` (manual).
describe('Notification delivery retry', () => {
  let repo: InMemoryDeliveryRepo;
  let notifier: ScriptedNotifier;
  let publisher: RecordingEventsPublisher;

  beforeEach(() => {
    repo = new InMemoryDeliveryRepo();
    notifier = new ScriptedNotifier();
    publisher = new RecordingEventsPublisher();
  });

  const manual = (maxAttempts: number): RetryDeliveryUseCase =>
    new RetryDeliveryUseCase(
      repo,
      notifier,
      publisher,
      maxAttempts,
      new FakeLogger() as unknown as PinoLogger,
    );

  const sweeper = (maxAttempts: number): RetryFailedDeliveriesUseCase =>
    new RetryFailedDeliveriesUseCase(
      repo,
      manual(maxAttempts),
      maxAttempts,
      new FakeLogger() as unknown as PinoLogger,
    );

  // Persists a `failed` delivery: open (queued) → `markFailed` (attemptCount 1) → save.
  // `lastAttemptAt` is settable so the sweeper backoff gate can be exercised.
  const seedFailed = async (
    overrides: { lastAttemptAt?: Date; eventReferenceId?: string } = {},
  ): Promise<NotificationDelivery> => {
    const opened = NotificationDelivery.open({
      templateId: 1,
      recipientCustomerId: 'cust-uuid-1',
      recipientAddress: 'ada@example.com',
      channel: NotificationChannelEnum.EMAIL,
      eventReferenceType: 'order',
      eventReferenceId: overrides.eventReferenceId ?? '99',
      renderedSubject: 'Order confirmed',
      renderedBody: 'Your order is on its way',
      correlationId: 'corr-1',
    });
    opened.markFailed(overrides.lastAttemptAt ?? new Date(), 'initial dispatch failed');
    return repo.save(opened);
  };

  describe('manual retry (RetryDeliveryUseCase)', () => {
    it('re-dispatches a failed delivery and flips it to sent on success', async () => {
      const failed = await seedFailed();
      notifier.shouldFail = false;

      const view = await manual(3).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      expect(view.status).toBe(NotificationDeliveryStatusEnum.SENT);
      // attemptCount climbs 1 → 2 (the retry counts as an attempt) and never resets.
      expect(view.attemptCount).toBe(2);
      expect(notifier.sent).toHaveLength(1);
      expect(notifier.sent[0].body).toBe('Your order is on its way');
      expect(publisher.published).toHaveLength(0);
    });

    it('records another failure (status failed, attemptCount incremented) below the cap', async () => {
      const failed = await seedFailed();
      notifier.shouldFail = true;

      const view = await manual(3).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      expect(view.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(view.attemptCount).toBe(2);
      // Below the cap (2 < 3): the alerting event is NOT emitted.
      expect(publisher.published).toHaveLength(0);
    });

    it('emits notifications.delivery.failed exactly once when the retry reaches the cap', async () => {
      // maxAttempts 2: the seeded row is already at attemptCount 1; one more failed attempt
      // hits the cap.
      const failed = await seedFailed();
      notifier.shouldFail = true;

      const view = await manual(2).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      expect(view.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(view.attemptCount).toBe(2);
      expect(publisher.published).toHaveLength(1);
      expect(publisher.published[0]).toMatchObject({
        deliveryId: failed.id,
        eventReferenceType: 'order',
        eventReferenceId: '99',
        eventVersion: 'v1',
      });
      expect(publisher.published[0].failureReason).toBe('SMTP 421 service unavailable');
    });

    it('rejects a non-failed delivery with DELIVERY_INVALID_STATUS_TRANSITION', async () => {
      // A delivery that has already been sent is not retryable.
      const failed = await seedFailed();
      notifier.shouldFail = false;
      const sent = await manual(3).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });
      expect(sent.status).toBe(NotificationDeliveryStatusEnum.SENT);

      await expect(
        manual(3).execute({ deliveryId: failed.id!, correlationId: 'corr-op' }),
      ).rejects.toMatchObject({
        code: NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
      });
    });

    it('throws DELIVERY_NOT_FOUND for an unknown delivery id', async () => {
      await expect(
        manual(3).execute({ deliveryId: 9999, correlationId: 'corr-op' }),
      ).rejects.toMatchObject({
        code: NotificationErrorCodeEnum.DELIVERY_NOT_FOUND,
      });
    });

    it('keeps attemptCount monotonic across repeated retries', async () => {
      const failed = await seedFailed();

      notifier.shouldFail = true;
      const after1 = await manual(5).execute({ deliveryId: failed.id!, correlationId: 'c' });
      expect(after1.attemptCount).toBe(2);

      notifier.shouldFail = true;
      const after2 = await manual(5).execute({ deliveryId: failed.id!, correlationId: 'c' });
      expect(after2.attemptCount).toBe(3);

      notifier.shouldFail = false;
      const after3 = await manual(5).execute({ deliveryId: failed.id!, correlationId: 'c' });
      expect(after3.attemptCount).toBe(4);
      expect(after3.status).toBe(NotificationDeliveryStatusEnum.SENT);
    });
  });

  describe('scheduled sweep (RetryFailedDeliveriesUseCase)', () => {
    it('skips a row still inside its backoff window and retries a due one', async () => {
      // Recent failure (lastAttemptAt ≈ now) → inside the 1s backoff window → skipped.
      const recent = await seedFailed({ lastAttemptAt: new Date(), eventReferenceId: 'recent' });
      // Old failure (lastAttemptAt 60s ago) → past the backoff window → due.
      const due = await seedFailed({
        lastAttemptAt: new Date(Date.now() - 60_000),
        eventReferenceId: 'due',
      });
      notifier.shouldFail = false;

      const result = await sweeper(3).execute();

      expect(result).toEqual({ scanned: 2, skipped: 1, retried: 1 });
      // Only the due row was re-dispatched and flipped to sent; the recent one is untouched.
      const dueAfter = await repo.findById(due.id!);
      const recentAfter = await repo.findById(recent.id!);
      expect(dueAfter?.status).toBe(NotificationDeliveryStatusEnum.SENT);
      expect(dueAfter?.attemptCount).toBe(2);
      expect(recentAfter?.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(recentAfter?.attemptCount).toBe(1);
      expect(notifier.sent).toHaveLength(1);
    });

    it('emits notifications.delivery.failed once when a swept retry reaches the cap', async () => {
      const due = await seedFailed({ lastAttemptAt: new Date(Date.now() - 60_000) });
      notifier.shouldFail = true;

      const result = await sweeper(2).execute();

      expect(result).toEqual({ scanned: 1, skipped: 0, retried: 1 });
      const after = await repo.findById(due.id!);
      expect(after?.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(after?.attemptCount).toBe(2);
      expect(publisher.published).toHaveLength(1);
    });
  });
});
