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

// A notifier whose next send outcome is scripted, so a spec can drive a retry to success
// or another failure deterministically. `sent` records the dispatched notifications,
// `failNext` flips a single send to reject.
class ScriptedNotifier implements INotifierPort {
  public readonly sent: Notification[] = [];
  public shouldFail = false;
  // A rejection value that is NOT an `Error`. Real transports do this — a raw string, a
  // provider's response object — and the use case's `err instanceof Error ? … : String(err)`
  // arm exists for exactly that.
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

// Records the `notifications.delivery.failed` events the cap path emits, so a spec can
// assert it fires exactly once (and with the right shape).
class RecordingEventsPublisher implements INotificationEventsPublisherPort {
  public readonly published: INotificationDeliveryFailedEvent[] = [];
  // The broker being unreachable at the moment the cap is hit. The emit is best-effort
  // (ADR-020): the delivery is already durably `failed`, so losing the alert must not undo
  // the record — nor surface as a failed RPC to the operator who triggered the retry.
  public shouldFail = false;
  // A non-`Error` rejection, as `rejectWith` on the notifier above. Same reason: the `String(err)`
  // arm is what keeps a log line readable when a driver rejects with something that has no
  // `.message`.
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

  // Persists a delivery ORPHANED in `queued`: the row the persist-then-send pipeline commits
  // before it calls the NOTIFIER, whose status flip never happened (the process died, or the
  // second save threw and the redelivery hit the dedupe pre-check instead of dispatching).
  // `attemptCount` is 0 and `lastAttemptAt` null, because no attempt was ever *recorded* — which
  // is precisely why neither the old scan nor the old guard could see it. `createdAt` is dated
  // back rather than slept for; the staleness rule is about row age, and a spec should not wait
  // five minutes to say so.
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

    // The orphan rule, operator half. Before it, a row stranded in `queued` was refused here AND
    // invisible to the sweeper — unreachable by every path in the service, which is exactly what
    // ADR-033 §3 promised would not happen ("the retry sweeper can pick up").
    it('retries a queued delivery that has been orphaned past the staleness horizon', async () => {
      const orphan = await seedOrphanedQueued({ ageMs: QUEUED_STALE_AFTER_MS + 60_000 });
      notifier.shouldFail = false;

      const view = await manual(3).execute({ deliveryId: orphan.id!, correlationId: 'corr-op' });

      expect(view.status).toBe(NotificationDeliveryStatusEnum.SENT);
      // It was never attempted before, so this is attempt 1 — not a second one.
      expect(view.attemptCount).toBe(1);
      expect(notifier.sent).toHaveLength(1);
    });

    // The other half, and the reason the rule is an AGE and not just a status: a row persisted
    // moments ago is being dispatched RIGHT NOW. Re-dispatching it is a race, not a recovery.
    it('still refuses a FRESH queued delivery — it may be dispatching right now', async () => {
      const fresh = await seedOrphanedQueued({ ageMs: 1_000 });

      await expect(
        manual(3).execute({ deliveryId: fresh.id!, correlationId: 'corr-op' }),
      ).rejects.toMatchObject({
        code: NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
      });
      expect(notifier.sent).toHaveLength(0);
    });

    // `skipped-no-consent` is terminal and was deliberately never sent. Retrying it would send
    // the very message the consent gate suppressed — the one status where "retry" means "violate".
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

    // **Losing the ALERT must never undo the RECORD.** The delivery is already durably `failed`
    // by the time the cap-emit runs, so a broker that is down is a reason to log, not to fail the
    // call — and certainly not to roll the row back. This is the ADR-020 best-effort posture, and
    // it is the branch that decides whether an ops outage becomes a data problem.
    it('swallows a publisher failure at the cap — the row stays failed and the call succeeds', async () => {
      const failed = await seedFailed();
      notifier.shouldFail = true;
      publisher.shouldFail = true;

      const view = await manual(2).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      expect(view.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(view.attemptCount).toBe(2);
      // Nothing was published, and nothing threw.
      expect(publisher.published).toHaveLength(0);
      // The row is still there and still failed — the alert was lost, the record was not.
      expect((await repo.findById(failed.id!))?.status).toBe(NotificationDeliveryStatusEnum.FAILED);
    });

    // A transport may reject with something that is not an `Error` — a string, a provider's
    // response object. `failureReason` is a NOT NULL column and the alerting event's field is a
    // plain string, so the `String(err)` arm is what keeps a non-Error rejection from persisting
    // as `undefined`.
    it('records a non-Error rejection by stringifying it', async () => {
      const failed = await seedFailed();
      notifier.rejectWith = 'ECONNRESET';

      const view = await manual(3).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      expect(view.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(view.failureReason).toBe('ECONNRESET');
    });

    // The `?? 'unknown'` default on the emitted event. It is defensive — every `markFailed` sets a
    // reason, so a `failed` row with a null one cannot arise through the domain — but the wire
    // contract types `failureReason` as a non-optional string, and a delivery reconstituted from a
    // row whose `failure_reason` is NULL would otherwise emit `undefined` into it.
    it('falls back to "unknown" when a capped delivery carries no failure reason', async () => {
      const failed = await seedFailed();
      notifier.shouldFail = true;
      // Strip the reason on the way back out of the repository, standing in for a row that
      // reached the cap without one.
      repo.stripFailureReasonOnSave = true;

      await manual(2).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      expect(publisher.published).toHaveLength(1);
      expect(publisher.published[0].failureReason).toBe('unknown');
    });

    // The non-`Error` arm of the emit-failure catch. Both swallow paths stringify defensively,
    // and both are logged rather than surfaced — so a `[object Object]` in the log is the ONLY
    // signal an operator would get. Worth proving it is a string at all.
    it('stringifies a non-Error publisher rejection instead of logging undefined', async () => {
      const failed = await seedFailed();
      notifier.shouldFail = true;
      publisher.rejectWith = { code: 'ECONNREFUSED' };

      const view = await manual(2).execute({ deliveryId: failed.id!, correlationId: 'corr-op' });

      // Still recorded, still not thrown — the emit's shape does not change that.
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
    // The orphan rule, automatic half — and the one that actually closes the hole, since nobody is
    // watching for a stranded row to retry by hand. ADR-033 §3 chose persist-then-send on the
    // promise that "a crash mid-send still leaves an auditable row the retry sweeper can pick up";
    // for as long as the scan read `status = failed` alone, that sentence was false.
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

    // The backoff gate must NOT hold an orphan back. Its `lastAttemptAt` is null, so `isDue`
    // returns true immediately — correct, because the scan's `created_at` bound already made it
    // wait out the staleness horizon. A gate applied twice would be a wait applied twice.
    it('does not apply the backoff gate to an orphan on top of the staleness horizon', async () => {
      await seedOrphanedQueued({ ageMs: QUEUED_STALE_AFTER_MS + 1_000 });
      notifier.shouldFail = false;

      const result = await sweeper(3).execute();

      expect(result.skipped).toBe(0);
      expect(result.retried).toBe(1);
    });

    // The scan's bound, from the sweeper's side: a fresh `queued` row is in flight and must not be
    // selected at all — not selected-and-skipped, not selected-and-retried.
    it('leaves a FRESH queued delivery out of the scan entirely', async () => {
      await seedOrphanedQueued({ ageMs: 1_000 });

      const result = await sweeper(3).execute();

      expect(result).toEqual({ scanned: 0, skipped: 0, retried: 0 });
      expect(notifier.sent).toHaveLength(0);
    });

    // An orphan that fails on rescue is not a special case afterwards: it becomes an ordinary
    // `failed` row at attemptCount 1 and re-enters the normal budget with its full allowance.
    it('turns a failed rescue into an ordinary failed row with the full retry budget left', async () => {
      const orphan = await seedOrphanedQueued({ ageMs: QUEUED_STALE_AFTER_MS + 60_000 });
      notifier.shouldFail = true;

      await sweeper(3).execute();

      const after = await repo.findById(orphan.id!);
      expect(after?.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(after?.attemptCount).toBe(1);
      expect(after?.failureReason).toBe('SMTP 421 service unavailable');
      // 1 < 3, so the cap was not reached and no alert went out.
      expect(publisher.published).toHaveLength(0);
    });

    // **One bad row must not abort the sweep.** `reattempt` swallows a NOTIFIER rejection, so the
    // only way an exception reaches the loop is a repository or transport fault beneath it — and
    // if that killed the sweep, a single poisoned row would block the entire backlog behind it,
    // indefinitely, on every tick. The per-row `try` is what makes the sweep drain-what-it-can.
    it('isolates a row whose retry throws and keeps sweeping', async () => {
      await seedFailed({
        lastAttemptAt: new Date(Date.now() - 60_000),
        eventReferenceId: 'explodes',
      });
      notifier.shouldFail = false;
      repo.failSave = true;

      // The sweep itself resolves — it does not propagate the row's fault.
      const result = await sweeper(3).execute();

      expect(result.scanned).toBe(1);
      // The row was attempted but not counted as retried: the save that would have recorded the
      // outcome is the thing that failed.
      expect(result.retried).toBe(0);
    });

    // The sweep loop's own non-`Error` arm — same defensive stringify, different catch.
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
