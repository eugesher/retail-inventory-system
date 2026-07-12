import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationMarketingSendPayload,
  NotificationChannelEnum,
  NotificationDeliveryView,
} from '@retail-inventory-system/contracts';

import { RenderAndDispatchUseCase } from './render-and-dispatch.use-case';
import { toNotificationDeliveryView } from './notification-delivery-view.factory';

// The staff-triggered marketing dispatch (ADR-037) — a thin mapper in front of the
// shared `RenderAndDispatchUseCase`. It exists so the marketing path is demonstrable
// end to end: the operator names a customer + a marketing `eventType`, and the consent
// gate inside Render & Dispatch decides send vs `skipped-no-consent`.
//
// The mapping is deliberately minimal: channel is `email`, the recipient is the
// customer (so the consent-gate can look up their consent and dedupe on their id), the
// reference type is the literal `marketing`, and the reference id is the per-send
// `campaignId` (minted at the gateway edge). Because `eventType` is a marketing key
// (NOT in `TRANSACTIONAL_EVENT_TYPES`), the gate weighs it against `marketingEmail`.
//
// Returns the resulting `NotificationDeliveryView` (sent, or the `skipped-no-consent`
// row, or a pre-existing duplicate), or `null` when no active marketing template resolves.
//
// **On a fresh database that `null` is the only outcome.** No marketing template is seeded
// anywhere — not by a migration, not by `scripts/test-db-seed.ts` — so this succeeds, sends
// nothing, and returns `null` until a staff member authors one and activates it.
@Injectable()
export class SendMarketingUseCase {
  constructor(
    private readonly renderAndDispatch: RenderAndDispatchUseCase,
    @InjectPinoLogger(SendMarketingUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: INotificationMarketingSendPayload,
  ): Promise<NotificationDeliveryView | null> {
    this.logger.info(
      {
        correlationId: payload.correlationId,
        customerId: payload.customerId,
        eventType: payload.eventType,
        campaignId: payload.campaignId,
      },
      'Received RPC: send marketing notification',
    );

    const delivery = await this.renderAndDispatch.execute({
      eventType: payload.eventType,
      channel: NotificationChannelEnum.EMAIL,
      recipientCustomerId: payload.customerId,
      recipientAddress: payload.customerEmail,
      eventReferenceType: 'marketing',
      eventReferenceId: payload.campaignId,
      context: payload.context,
      correlationId: payload.correlationId,
    });

    return delivery === null ? null : toNotificationDeliveryView(delivery);
  }
}
