import { OrderCancelledEvent, OrderConfirmedEvent, OrderCreatedEvent } from '../../domain';

export const ORDER_EVENTS_PUBLISHER = Symbol('ORDER_EVENTS_PUBLISHER');

// Adapter materializes the cold Observable from `ClientProxy.emit()` and
// awaits the broker ack so callers depend on a plain Promise.
export interface IOrderEventsPublisherPort {
  publishOrderCreated(event: OrderCreatedEvent, correlationId?: string): Promise<void>;
  publishOrderConfirmed(event: OrderConfirmedEvent, correlationId?: string): Promise<void>;
  publishOrderCancelled(event: OrderCancelledEvent, correlationId?: string): Promise<void>;
}
