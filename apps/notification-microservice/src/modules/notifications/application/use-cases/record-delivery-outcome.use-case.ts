import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationDeliveryRecordOutcomePayload,
  NotificationDeliveryView,
} from '@retail-inventory-system/contracts';

import { NotificationDomainException, NotificationErrorCodeEnum } from '../../domain';
import { INotificationDeliveryRepositoryPort, NOTIFICATION_DELIVERY_REPOSITORY } from '../ports';
import { toNotificationDeliveryView } from './notification-delivery-view.factory';

// Fallback bounce reason when the webhook reports a `bounced` outcome with no detail —
// `NotificationDelivery.markBounced(reason)` requires a non-empty reason, so the audit row
// always records *why* it bounced even if the provider sent nothing.
const DEFAULT_BOUNCE_REASON = 'Delivery bounced';

// Record Delivery Outcome: the seam a real ESP (email service provider) delivery webhook
// would drive — flip a `sent` delivery to `delivered` (a downstream delivery receipt) or
// `bounced` (a bounce notice). These are the two attempt-free, terminal receipt
// transitions on the `NotificationDelivery` aggregate (ADR-033).
//
// The webhook ingestion itself — the HTTP endpoint, ESP signature verification, and
// provider-payload → outcome mapping — is **out of scope this capability**. This use case
// is reachable only via the `notification.delivery.record-outcome` RPC as the internal
// sketch a future webhook bridge would call; it is deliberately NOT exposed at the
// gateway. Real ESP integration is future work.
//
// State rules (enforced by the domain mutators, surfaced as typed codes):
// - unknown `deliveryId` → `DELIVERY_NOT_FOUND` (404);
// - a non-`sent` source row (`queued` / `failed` / already-`delivered` / `bounced`) →
//   `DELIVERY_INVALID_STATUS_TRANSITION` (409) — `markDelivered` / `markBounced` require
//   an exact prior `sent`.
@Injectable()
export class RecordDeliveryOutcomeUseCase {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly repository: INotificationDeliveryRepositoryPort,
    @InjectPinoLogger(RecordDeliveryOutcomeUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: INotificationDeliveryRecordOutcomePayload,
  ): Promise<NotificationDeliveryView> {
    const { deliveryId, outcome, failureReason, correlationId } = payload;

    this.logger.info(
      { correlationId, deliveryId, outcome },
      'Received RPC: record notification delivery outcome',
    );

    const delivery = await this.repository.findById(deliveryId);
    if (delivery === null) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.DELIVERY_NOT_FOUND,
        `Notification delivery ${deliveryId} not found`,
      );
    }

    // The domain mutators are the single source of the `sent → delivered|bounced` guard;
    // an illegal start raises `DELIVERY_INVALID_STATUS_TRANSITION` (409).
    if (outcome === 'delivered') {
      delivery.markDelivered();
    } else {
      delivery.markBounced(failureReason ?? DEFAULT_BOUNCE_REASON);
    }

    const saved = await this.repository.save(delivery);

    this.logger.info(
      { correlationId, deliveryId: saved.id, status: saved.status },
      'Notification delivery outcome recorded',
    );

    return toNotificationDeliveryView(saved);
  }
}
