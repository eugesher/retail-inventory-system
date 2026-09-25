import { PinoLogger } from 'nestjs-pino';

import {
  INotificationDeliveryFailedEvent,
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { Notification, NotificationDelivery, NotificationErrorCodeEnum } from '../../../domain';
import { INotificationEventsPublisherPort, INotifierPort } from '../../ports';
import { QUEUED_STALE_AFTER_MS } from '../queued-staleness';
import { RetryDeliveryUseCase } from '../retry-delivery.use-case';
import { RetryFailedDeliveriesUseCase } from '../retry-failed-deliveries.use-case';
import { FakeLogger, InMemoryDeliveryRepo, rejectWithNonError } from './test-doubles';

class ScriptedNotifier implements INotifierPort {
  public readonly sent: Notification[] = [];
  public shouldFail = false;
  public rejectWith: unknown = undefined;

  public send(notification: Notification): Promise<void> {
    if (this.rejectWith !== undefined) {
      return rejectWithNonError(this.rejectWith);
    }
    if (this.shouldFail) {
      return Promise.reject(new Error('SMTP 421 service unavailable'));
    }
    this.sent.push(notification);
    return Promise.resolve();
  }
}

class RecordingEventsPublisher implements INotificationEventsPublisherPort {
  public readonly published: INotificationDeliveryFailedEvent[] = [];
  public shouldFail = false;
  public rejectWith: unknown = undefined;

  public publishDeliveryFailed(event: INotificationDeliveryFailedEvent): Promise<void> {
    if (this.rejectWith !== undefined) {
      return rejectWithNonError(this.rejectWith);
    }
    if (this.shouldFail) {
      return Promise.reject(new Error('AMQP channel closed'));
    }
    this.published.push(event);
    return Promise.resolve();
  }
}

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

  const seedOrphanedQueued = async (overrides: { ageMs: number }): Promise<NotificationDelivery> =>
    repo.save(
      NotificationDelivery.reconstitute({
        id: null,
        templateId: 1,
        recipientCustomerId: 'cust-uuid-1',
        recipientAddress: 'ada@example.com',
        channel: NotificationChannelEnum.EMAIL,
        eventReferenceType: 'order',
        eventReferenceId: 'orphan',
        status: NotificationDeliveryStatusEnum.QUEUED,
        attemptCount: 0,
        lastAttemptAt: null,
        failureReason: null,
        renderedSubject: 'Order confirmed',
        renderedBody: 'Your order is on its way',
        correlationId: 'corr-orphan',
        createdAt: new Date(Date.now() - overrides.ageMs),
      }),
    );

  describe('manual retry (RetryDeliveryUseCase)', () => {
    it('re-dispatches a failed delivery and flips it to sent on success', async () => {
      const failed = await seedFailed();
      notifier.shouldFail = false;

      const view = await manual(3).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      expect(view.status).toBe(NotificationDeliveryStatusEnum.SENT);
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
      expect(publisher.published).toHaveLength(0);
    });

    it('emits notifications.delivery.failed exactly once when the retry reaches the cap', async () => {
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

    it('retries a queued delivery that has been orphaned past the staleness horizon', async () => {
      const orphan = await seedOrphanedQueued({ ageMs: QUEUED_STALE_AFTER_MS + 60_000 });
      notifier.shouldFail = false;

      const view = await manual(3).execute({ deliveryId: orphan.id!, correlationId: 'corr-op' });

      expect(view.status).toBe(NotificationDeliveryStatusEnum.SENT);
      expect(view.attemptCount).toBe(1);
      expect(notifier.sent).toHaveLength(1);
    });

    it('still refuses a FRESH queued delivery — it may be dispatching right now', async () => {
      const fresh = await seedOrphanedQueued({ ageMs: 1_000 });

      await expect(
        manual(3).execute({ deliveryId: fresh.id!, correlationId: 'corr-op' }),
      ).rejects.toMatchObject({
        code: NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
      });
      expect(notifier.sent).toHaveLength(0);
    });

    it('refuses a skipped-no-consent delivery no matter how old it is', async () => {
      const skipped = NotificationDelivery.skipped({
        templateId: 1,
        recipientCustomerId: 'cust-uuid-1',
        recipientAddress: 'ada@example.com',
        channel: NotificationChannelEnum.EMAIL,
        eventReferenceType: 'marketing',
        eventReferenceId: 'campaign-1',
        renderedSubject: 'Promo',
        renderedBody: 'Save 20%',
        correlationId: 'corr-1',
      });
      const saved = await repo.save(skipped);

      await expect(
        manual(3).execute({ deliveryId: saved.id!, correlationId: 'corr-op' }),
      ).rejects.toMatchObject({
        code: NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
      });
      expect(notifier.sent).toHaveLength(0);
    });

    it('swallows a publisher failure at the cap — the row stays failed and the call succeeds', async () => {
      const failed = await seedFailed();
      notifier.shouldFail = true;
      publisher.shouldFail = true;

      const view = await manual(2).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      expect(view.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(view.attemptCount).toBe(2);
      expect(publisher.published).toHaveLength(0);
      expect((await repo.findById(failed.id!))?.status).toBe(NotificationDeliveryStatusEnum.FAILED);
    });

    it('records a non-Error rejection by stringifying it', async () => {
      const failed = await seedFailed();
      notifier.rejectWith = 'ECONNRESET';

      const view = await manual(3).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      expect(view.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(view.failureReason).toBe('ECONNRESET');
    });

    it('falls back to "unknown" when a capped delivery carries no failure reason', async () => {
      const failed = await seedFailed();
      notifier.shouldFail = true;
      repo.stripFailureReasonOnSave = true;

      await manual(2).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      expect(publisher.published).toHaveLength(1);
      expect(publisher.published[0].failureReason).toBe('unknown');
    });

    it('stringifies a non-Error publisher rejection instead of logging undefined', async () => {
      const failed = await seedFailed();
      notifier.shouldFail = true;
      publisher.rejectWith = { code: 'ECONNREFUSED' };

      const view = await manual(2).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      expect(view.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(publisher.published).toHaveLength(0);
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
    it('rescues a queued delivery orphaned past the staleness horizon', async () => {
      const orphan = await seedOrphanedQueued({ ageMs: QUEUED_STALE_AFTER_MS + 60_000 });
      notifier.shouldFail = false;

      const result = await sweeper(3).execute();

      expect(result).toEqual({ scanned: 1, skipped: 0, retried: 1 });
      const after = await repo.findById(orphan.id!);
      expect(after?.status).toBe(NotificationDeliveryStatusEnum.SENT);
      expect(after?.attemptCount).toBe(1);
      expect(notifier.sent).toHaveLength(1);
    });

    it('does not apply the backoff gate to an orphan on top of the staleness horizon', async () => {
      await seedOrphanedQueued({ ageMs: QUEUED_STALE_AFTER_MS + 1_000 });
      notifier.shouldFail = false;

      const result = await sweeper(3).execute();

      expect(result.skipped).toBe(0);
      expect(result.retried).toBe(1);
    });

    it('leaves a FRESH queued delivery out of the scan entirely', async () => {
      await seedOrphanedQueued({ ageMs: 1_000 });

      const result = await sweeper(3).execute();

      expect(result).toEqual({ scanned: 0, skipped: 0, retried: 0 });
      expect(notifier.sent).toHaveLength(0);
    });

    it('turns a failed rescue into an ordinary failed row with the full retry budget left', async () => {
      const orphan = await seedOrphanedQueued({ ageMs: QUEUED_STALE_AFTER_MS + 60_000 });
      notifier.shouldFail = true;

      await sweeper(3).execute();

      const after = await repo.findById(orphan.id!);
      expect(after?.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(after?.attemptCount).toBe(1);
      expect(after?.failureReason).toBe('SMTP 421 service unavailable');
      expect(publisher.published).toHaveLength(0);
    });

    it('isolates a row whose retry throws and keeps sweeping', async () => {
      await seedFailed({
        lastAttemptAt: new Date(Date.now() - 60_000),
        eventReferenceId: 'explodes',
      });
      notifier.shouldFail = false;
      repo.failSave = true;

      const result = await sweeper(3).execute();

      expect(result.scanned).toBe(1);
      expect(result.retried).toBe(0);
    });

    it('isolates a row whose retry rejects with a non-Error and keeps sweeping', async () => {
      await seedFailed({
        lastAttemptAt: new Date(Date.now() - 60_000),
        eventReferenceId: 'explodes-oddly',
      });
      repo.failSaveWith = 'ER_LOCK_DEADLOCK';

      const result = await sweeper(3).execute();

      expect(result.scanned).toBe(1);
      expect(result.retried).toBe(0);
    });

    it('skips a row still inside its backoff window and retries a due one', async () => {
      const recent = await seedFailed({ lastAttemptAt: new Date(), eventReferenceId: 'recent' });
      const due = await seedFailed({
        lastAttemptAt: new Date(Date.now() - 60_000),
        eventReferenceId: 'due',
      });
      notifier.shouldFail = false;

      const result = await sweeper(3).execute();

      expect(result).toEqual({ scanned: 2, skipped: 1, retried: 1 });
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
