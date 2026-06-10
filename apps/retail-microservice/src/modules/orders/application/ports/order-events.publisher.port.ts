import {
  IRetailOrderPlacedEvent,
  IRetailPaymentAuthorizedEvent,
} from '@retail-inventory-system/contracts';

export const ORDER_EVENTS_PUBLISHER = Symbol('ORDER_EVENTS_PUBLISHER');

// The orders context's event-publishing seam. The use case has already built the
// versioned wire event; the adapter just emits it and waits for the broker ack.
// Domain/contract types only — no `@nestjs/microservices` here (ADR-009); the
// concrete `OrderRabbitmqPublisher` holds the two `ClientProxy`s.
//
// `publishOrderPlaced` emits `retail.order.placed` onto `notification_events` (the
// consumer's queue — the producer-targets-consumer-queue pattern of ADR-008/020);
// `publishPaymentAuthorized` emits `retail.payment.authorized` onto `retail_queue`
// (a reserved surface, like the `retail.cart.*` events). Both are best-effort
// post-commit emits — the place write has already committed, so a publish failure
// is warn-logged and swallowed by the caller (ADR-020).
export interface IOrderEventsPublisherPort {
  publishOrderPlaced(event: IRetailOrderPlacedEvent): Promise<void>;
  publishPaymentAuthorized(event: IRetailPaymentAuthorizedEvent): Promise<void>;
}
