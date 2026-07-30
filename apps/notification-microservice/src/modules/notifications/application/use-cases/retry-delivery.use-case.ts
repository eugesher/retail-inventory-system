import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationDeliveryFailedEvent,
  INotificationDeliveryRetryPayload,
  NotificationDeliveryStatusEnum,
  NotificationDeliveryView,
} from '@retail-inventory-system/contracts';

import {
  Notification,
  NotificationDelivery,
  NotificationDomainException,
  NotificationErrorCodeEnum,
} from '../../domain';
import {
  INotificationDeliveryRepositoryPort,
  INotificationEventsPublisherPort,
  INotifierPort,
  MAX_DELIVERY_ATTEMPTS,
  NOTIFICATION_DELIVERY_REPOSITORY,
  NOTIFICATION_EVENTS_PUBLISHER,
  NOTIFIER,
} from '../ports';
import { toNotificationDeliveryView } from './notification-delivery-view.factory';
import { isOrphanedQueued, QUEUED_STALE_AFTER_MS } from './queued-staleness';
import { resolveTransportSubject } from './transport-subject';

// Retry Delivery — the operator manual-retry of one `failed` notification delivery
// (ADR-033), the `notification.delivery.retry` RPC. It re-dispatches the
// **already-rendered** subject/body persisted on the delivery row (no template
// re-lookup — the row is a self-contained snapshot of what was rendered, so a later
// template edit cannot change what a retry sends), flips the row `sent`/`failed`, and at
// the attempt cap emits the `notifications.delivery.failed` alerting event.
//
// A manual retry **forces past the backoff gate** the scheduled sweeper
// (`RetryFailedDeliveriesUseCase`) honors — an operator deciding to retry now overrides
// the "too soon" wait. The single re-dispatch + cap-emit step lives in `reattempt`, which
// the sweeper calls directly with an already-loaded failed row (so the two retry paths
// share one source of truth; the one-use-case-with-multiple-public-methods precedent).
//
// State rule: a `failed` delivery is retryable, and so is a `queued` one that has been
// orphaned mid-dispatch (older than the staleness horizon — `queued-staleness.ts`). An
// unknown id → `DELIVERY_NOT_FOUND` (404); anything else, including a FRESH `queued` row
// that is plausibly still dispatching → `DELIVERY_INVALID_STATUS_TRANSITION` (409).
// `correlationId` is logged inline (ADR-011 §7).
@Injectable()
export class RetryDeliveryUseCase {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly deliveryRepo: INotificationDeliveryRepositoryPort,
    @Inject(NOTIFIER)
    private readonly notifier: INotifierPort,
    @Inject(NOTIFICATION_EVENTS_PUBLISHER)
    private readonly eventsPublisher: INotificationEventsPublisherPort,
    @Inject(MAX_DELIVERY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(RetryDeliveryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: INotificationDeliveryRetryPayload,
  ): Promise<NotificationDeliveryView> {
    const { deliveryId, correlationId } = payload;

    this.logger.info({ correlationId, deliveryId }, 'Received RPC: retry notification delivery');

    const delivery = await this.deliveryRepo.findById(deliveryId);
    if (delivery === null) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.DELIVERY_NOT_FOUND,
        `Notification delivery ${deliveryId} not found`,
      );
    }

    // Two things are retryable, and the second is the narrow one:
    //
    //  - a `failed` delivery — the ordinary case, a recorded transport rejection;
    //  - a `queued` delivery **older than the staleness horizon** — a row orphaned between
    //    the persist and the dispatch (`queued-staleness.ts`). A FRESH `queued` row is still
    //    refused: it is being dispatched right now, and re-dispatching it is not recovery.
    //
    // Everything else double-sends: a `sent`/`delivered`/`bounced` row already succeeded,
    // and a `skipped-no-consent` row was deliberately not sent at all. (`markSent` /
    // `markFailed` would *accept* a `queued` row — `assertAttemptable` always has — so the
    // age half of this rule is the use case's, not the model's.)
    if (
      delivery.status !== NotificationDeliveryStatusEnum.FAILED &&
      !isOrphanedQueued(delivery, new Date())
    ) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
        delivery.status === NotificationDeliveryStatusEnum.QUEUED
          ? `Notification delivery ${deliveryId} is queued and may still be dispatching; it becomes retryable once it is older than ${QUEUED_STALE_AFTER_MS}ms`
          : `Notification delivery ${deliveryId} is not retryable (status: ${delivery.status}); only a failed delivery, or a queued one orphaned mid-dispatch, can be retried`,
      );
    }

    const reattempted = await this.reattempt(delivery, correlationId);
    return toNotificationDeliveryView(reattempted);
  }

  // Re-dispatch one already-`failed` delivery exactly once, then persist the new status.
  // Shared by the manual RPC (above) and the scheduled sweeper — the caller is
  // responsible for deciding the delivery is *due* for a retry (the manual path forces it;
  // the sweeper applies the backoff gate). At the cap (`attemptCount >= maxAttempts` and
  // still `failed`) it emits `notifications.delivery.failed` once. Returns the persisted
  // post-retry aggregate.
  public async reattempt(
    delivery: NotificationDelivery,
    correlationId: string,
  ): Promise<NotificationDelivery> {
    // The `Notification` value object requires a non-empty subject; a null-subject channel
    // (sms/push) falls back to the `eventReferenceType` so the transport always has a
    // line. EMAIL always carries a rendered subject this capability, so the fallback is
    // dormant for now — but it keeps the retry honest for non-email channels.
    const subjectForTransport = resolveTransportSubject(
      delivery.renderedSubject,
      delivery.eventReferenceType,
    );

    const now = new Date();
    try {
      await this.notifier.send(
        new Notification({
          recipient: delivery.recipientAddress,
          channel: delivery.channel,
          subject: subjectForTransport,
          body: delivery.renderedBody,
          metadata: {
            deliveryId: delivery.id,
            eventReferenceType: delivery.eventReferenceType,
            eventReferenceId: delivery.eventReferenceId,
            correlationId,
            retry: true,
          },
        }),
      );
      delivery.markSent(now);
      this.logger.info(
        { correlationId, deliveryId: delivery.id, attemptCount: delivery.attemptCount },
        'Notification delivery retry succeeded',
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      delivery.markFailed(now, reason);
      this.logger.warn(
        { correlationId, deliveryId: delivery.id, attemptCount: delivery.attemptCount, reason },
        'Notification delivery retry failed',
      );
    }

    const saved = await this.deliveryRepo.save(delivery);

    // At the cap and still failed → emit the alerting event once. After this attempt the
    // sweeper's `listRetryable` scan (`attempt_count < maxAttempts`) excludes the row, so
    // a scheduled retry never re-emits; a manual force-retry past the cap may re-emit (an
    // operator's deliberate act). The emit is best-effort (ADR-020) — the row is already
    // persisted `failed`, so a publish failure is warn-logged and swallowed.
    if (
      saved.status === NotificationDeliveryStatusEnum.FAILED &&
      saved.attemptCount >= this.maxAttempts
    ) {
      await this.emitDeliveryFailed(saved, correlationId);
    }

    return saved;
  }

  private async emitDeliveryFailed(
    delivery: NotificationDelivery,
    correlationId: string,
  ): Promise<void> {
    const event: INotificationDeliveryFailedEvent = {
      deliveryId: delivery.id!,
      eventReferenceType: delivery.eventReferenceType,
      eventReferenceId: delivery.eventReferenceId,
      failureReason: delivery.failureReason ?? 'unknown',
      eventVersion: 'v1',
      correlationId,
      occurredAt: new Date().toISOString(),
    };
    try {
      await this.eventsPublisher.publishDeliveryFailed(event);
      this.logger.warn(
        { correlationId, deliveryId: delivery.id, attemptCount: delivery.attemptCount },
        'Notification delivery exhausted retry budget; emitted notifications.delivery.failed',
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { correlationId, deliveryId: delivery.id, reason },
        'Failed to emit notifications.delivery.failed (swallowed)',
      );
    }
  }
}
