import { OrderCancelledEvent, OrderConfirmedEvent, OrderCreatedEvent } from '../../domain';

export const ORDER_EVENTS_PUBLISHER = Symbol('ORDER_EVENTS_PUBLISHER');

// Wraps the cold-observable RxJS dance from `ClientProxy.emit()` (see
// _carryover-07 §5 #3 and _carryover-08 §12 #5). Application code awaits a
// plain Promise; the adapter is responsible for materializing the
// observable and waiting on the broker ack.
//
// Today the only producer wired in is `publishOrderCreated` — the
// notification microservice subscribes to `retail.order.created`. The
// confirmed/cancelled methods are no-op defaults at the adapter level; their
// surface exists so a future cross-service consumer can be wired without a
// port-shape change.
export interface IOrderEventsPublisherPort {
  publishOrderCreated(event: OrderCreatedEvent, correlationId?: string): Promise<void>;
  publishOrderConfirmed(event: OrderConfirmedEvent, correlationId?: string): Promise<void>;
  publishOrderCancelled(event: OrderCancelledEvent, correlationId?: string): Promise<void>;
}
