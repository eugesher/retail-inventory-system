import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IRetailFulfillmentCreatedEvent,
  IRetailFulfillmentDeliveredEvent,
  IRetailFulfillmentShippedEvent,
  IRetailOrderCancelledEvent,
  IRetailOrderPlacedEvent,
  IRetailPaymentAuthorizedEvent,
  IRetailPaymentCapturedEvent,
  IRetailRefundFailedEvent,
  IRetailRefundIssuedEvent,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IOrderEventsPublisherPort } from '../../application/ports';

// The orders context's event publisher and the second of the module's `ClientProxy`
// holders (ADR-009 / ADR-020). The use case has already built the versioned wire
// event; this adapter just emits it and waits for the broker ack.
//
// `retail.order.placed` is emitted through the `NOTIFICATION_MICROSERVICE` client so
// it lands on `notification_events` — the consumer's own queue, the
// producer-targets-consumer-queue pattern (ADR-008/020) that `inventory.stock.low →
// notification_events` uses. Its consumer (an order-confirmation fan-out) binds with
// the notification re-point capability. `retail.payment.authorized` is emitted
// through the `RETAIL_MICROSERVICE` client onto `retail_queue` (the producer's own
// queue) — a reserved surface today, like the four `retail.cart.*` events.
@Injectable()
export class OrderRabbitmqPublisher implements IOrderEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailClient: ClientProxy,
  ) {}

  public async publishOrderPlaced(event: IRetailOrderPlacedEvent): Promise<void> {
    // `ClientProxy.emit()` is a cold Observable; `firstValueFrom` materializes it
    // and waits for the broker ack so callers depend on a plain Promise.
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailOrderPlacedEvent>(
        ROUTING_KEYS.RETAIL_ORDER_PLACED,
        event,
      ),
    );
  }

  public async publishPaymentAuthorized(event: IRetailPaymentAuthorizedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailPaymentAuthorizedEvent>(
        ROUTING_KEYS.RETAIL_PAYMENT_AUTHORIZED,
        event,
      ),
    );
  }

  public async publishPaymentCaptured(event: IRetailPaymentCapturedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailPaymentCapturedEvent>(
        ROUTING_KEYS.RETAIL_PAYMENT_CAPTURED,
        event,
      ),
    );
  }

  // `retail.fulfillment.created` rides the `RETAIL_MICROSERVICE` client onto
  // `retail_queue` (the producer's own queue) — a reserved surface today, like the
  // `retail.payment.*` events.
  public async publishFulfillmentCreated(event: IRetailFulfillmentCreatedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailFulfillmentCreatedEvent>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_CREATED,
        event,
      ),
    );
  }

  // `retail.fulfillment.shipped` is emitted through the `NOTIFICATION_MICROSERVICE`
  // client so it lands on `notification_events` — the consumer's own queue, the
  // producer-targets-consumer-queue pattern (ADR-008/020) that `retail.order.placed`
  // uses. The notification service binds a shipment-confirmation consumer for it.
  public async publishFulfillmentShipped(event: IRetailFulfillmentShippedEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailFulfillmentShippedEvent>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_SHIPPED,
        event,
      ),
    );
  }

  // `retail.fulfillment.delivered` is emitted through the `NOTIFICATION_MICROSERVICE`
  // client onto `notification_events` (the consumer's own queue), where the
  // notification service binds a delivery-confirmation consumer beside the shipped one.
  public async publishFulfillmentDelivered(event: IRetailFulfillmentDeliveredEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailFulfillmentDeliveredEvent>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_DELIVERED,
        event,
      ),
    );
  }

  // `retail.order.cancelled` is **dual-emitted** (ADR-033) — it has two distinct consumers
  // on two queues:
  //   - `retail_queue` (the `RETAIL_MICROSERVICE` client) — retail's **own** auto-refund
  //     `OrderCancelledConsumer`, which on `paymentFlaggedForRefund=true` issues the refund;
  //   - `notification_events` (the `NOTIFICATION_MICROSERVICE` client) — the notification
  //     service's cancellation-confirmation consumer, which needs the `customerEmail` the
  //     event now carries.
  // Both emits fire concurrently via `Promise.all` so neither blocks the other; the caller
  // wraps this in best-effort post-commit handling (a publish failure is warn-logged and
  // swallowed — the cancel already committed, and `payment.flagged_for_refund` is the durable
  // retry anchor for the refund leg, ADR-032). The key, retired by ADR-028 with the old order
  // model, was re-introduced fresh by the Cancel Order producer (ADR-031); this adds its
  // second destination.
  public async publishOrderCancelled(event: IRetailOrderCancelledEvent): Promise<void> {
    await Promise.all([
      firstValueFrom(
        this.retailClient.emit<void, IRetailOrderCancelledEvent>(
          ROUTING_KEYS.RETAIL_ORDER_CANCELLED,
          event,
        ),
      ),
      firstValueFrom(
        this.notificationClient.emit<void, IRetailOrderCancelledEvent>(
          ROUTING_KEYS.RETAIL_ORDER_CANCELLED,
          event,
        ),
      ),
    ]);
  }

  // `retail.refund.issued` is emitted through the `NOTIFICATION_MICROSERVICE` client so it
  // lands on `notification_events` — the consumer's own queue, the
  // producer-targets-consumer-queue pattern (ADR-008/020) — where the notification service
  // binds a refund-confirmation fan-out.
  public async publishRefundIssued(event: IRetailRefundIssuedEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailRefundIssuedEvent>(
        ROUTING_KEYS.RETAIL_REFUND_ISSUED,
        event,
      ),
    );
  }

  // `retail.refund.failed` rides the `RETAIL_MICROSERVICE` client onto `retail_queue`
  // (the producer's own queue) — a reserved surface today (no consumer), modeled for a
  // real gateway decline (unreachable with the always-succeed fake).
  public async publishRefundFailed(event: IRetailRefundFailedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailRefundFailedEvent>(
        ROUTING_KEYS.RETAIL_REFUND_FAILED,
        event,
      ),
    );
  }
}
