import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IRetailFulfillmentDeliveredEvent,
  IRetailFulfillmentShippedEvent,
} from '@retail-inventory-system/contracts';

import { Notification, NotificationChannelEnum } from '../../domain';
import { INotifierPort, NOTIFIER } from '../ports';

// Fans the two fulfillment lifecycle events — `retail.fulfillment.shipped` and
// `retail.fulfillment.delivered` — out through the notifier. One use case with two
// typed entry methods (mirroring `SendOrderNotificationUseCase`): the shipped and
// delivered wire shapes differ (shipped carries the carrier + tracking header,
// delivered carries only the delivery timestamp), so a method per kind keeps each
// `Notification` body honest without a discriminated-union cast.
//
// Delivery is the `LogNotifierAdapter` this capability — the body is a structured log
// line; templated email/SMS confirmation is a later notification capability. The
// `correlationId` is logged inline (never via `PinoLogger.assign`, which throws outside
// request scope, ADR-011 §7).
@Injectable()
export class SendShipmentNotificationUseCase {
  constructor(
    @Inject(NOTIFIER)
    private readonly notifier: INotifierPort,
    @InjectPinoLogger(SendShipmentNotificationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async shipped(event: IRetailFulfillmentShippedEvent): Promise<void> {
    const carrier = event.carrier ?? 'the carrier';

    const notification = new Notification({
      recipient: `order:${event.orderId}`,
      channel: NotificationChannelEnum.LOG,
      subject: `Shipment shipped for order ${event.orderId}`,
      body:
        `Fulfillment ${event.fulfillmentId} for order ${event.orderId} shipped via ` +
        `${carrier} (tracking ${event.trackingNumber}).`,
      metadata: {
        orderId: event.orderId,
        fulfillmentId: event.fulfillmentId,
        trackingNumber: event.trackingNumber,
        carrier: event.carrier,
        shippedAt: event.shippedAt,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        orderId: event.orderId,
        fulfillmentId: event.fulfillmentId,
        trackingNumber: event.trackingNumber,
        carrier: event.carrier,
      },
      'Dispatching shipment-shipped notification',
    );

    await this.notifier.send(notification);
  }

  public async delivered(event: IRetailFulfillmentDeliveredEvent): Promise<void> {
    const notification = new Notification({
      recipient: `order:${event.orderId}`,
      channel: NotificationChannelEnum.LOG,
      subject: `Shipment delivered for order ${event.orderId}`,
      body:
        `Fulfillment ${event.fulfillmentId} for order ${event.orderId} was delivered ` +
        `at ${event.deliveredAt}.`,
      metadata: {
        orderId: event.orderId,
        fulfillmentId: event.fulfillmentId,
        deliveredAt: event.deliveredAt,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        orderId: event.orderId,
        fulfillmentId: event.fulfillmentId,
        deliveredAt: event.deliveredAt,
      },
      'Dispatching shipment-delivered notification',
    );

    await this.notifier.send(notification);
  }
}
