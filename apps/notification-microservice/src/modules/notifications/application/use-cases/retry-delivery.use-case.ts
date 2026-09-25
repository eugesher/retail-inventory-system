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

  public async reattempt(
    delivery: NotificationDelivery,
    correlationId: string,
  ): Promise<NotificationDelivery> {
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
