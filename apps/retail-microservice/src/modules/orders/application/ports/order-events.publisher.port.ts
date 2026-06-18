import {
  IRetailFulfillmentCreatedEvent,
  IRetailFulfillmentDeliveredEvent,
  IRetailFulfillmentShippedEvent,
  IRetailOrderCancelledEvent,
  IRetailOrderPlacedEvent,
  IRetailPaymentAuthorizedEvent,
  IRetailPaymentCapturedEvent,
} from '@retail-inventory-system/contracts';

export const ORDER_EVENTS_PUBLISHER = Symbol('ORDER_EVENTS_PUBLISHER');

// The orders context's event-publishing seam. The use case has already built the
// versioned wire event; the adapter just emits it and waits for the broker ack.
// Domain/contract types only — no `@nestjs/microservices` here (ADR-009); the
// concrete `OrderRabbitmqPublisher` holds the two `ClientProxy`s.
//
// Two destinations, by the producer-targets-consumer-queue pattern (ADR-008/020):
// `publishOrderPlaced` / `publishFulfillmentShipped` / `publishFulfillmentDelivered`
// emit `retail.order.placed` / `retail.fulfillment.shipped` /
// `retail.fulfillment.delivered` onto `notification_events` (the notification service's
// own queue — it consumes all three for its order/shipment fan-out);
// `publishPaymentAuthorized` / `publishPaymentCaptured` / `publishFulfillmentCreated` /
// `publishOrderCancelled` emit `retail.payment.authorized` / `retail.payment.captured` /
// `retail.fulfillment.created` / `retail.order.cancelled` onto `retail_queue` (the
// producer's own queue — reserved surfaces today, no consumer). Each is a best-effort
// post-commit emit — the write has already committed, so a publish failure is
// warn-logged and swallowed by the caller (ADR-020).
export interface IOrderEventsPublisherPort {
  publishOrderPlaced(event: IRetailOrderPlacedEvent): Promise<void>;
  publishPaymentAuthorized(event: IRetailPaymentAuthorizedEvent): Promise<void>;
  publishPaymentCaptured(event: IRetailPaymentCapturedEvent): Promise<void>;
  publishFulfillmentCreated(event: IRetailFulfillmentCreatedEvent): Promise<void>;
  publishFulfillmentShipped(event: IRetailFulfillmentShippedEvent): Promise<void>;
  publishFulfillmentDelivered(event: IRetailFulfillmentDeliveredEvent): Promise<void>;
  publishOrderCancelled(event: IRetailOrderCancelledEvent): Promise<void>;
}
