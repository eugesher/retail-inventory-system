import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.cart.line-quantity-changed` event, published
// when a line's quantity is set to a new positive value (a `0` is rejected at the
// domain — removal is the explicit op). Framework-free — a `DomainEvent` subclass
// is never serialized across services (ADR-011); the cart use case maps the
// in-process `CartLineQuantityChangedEvent` to this interface before emitting.
//
// A reserved surface today (no cross-service consumer bound). `lineId` is the
// BIGINT `cart_line.id`; `quantity` is the new quantity. `eventVersion` is pinned
// to `'v1'`; `occurredAt` is an ISO-8601 string.
export interface IRetailCartLineQuantityChangedEvent extends ICorrelationPayload {
  cartId: string;
  lineId: number;
  quantity: number;
  eventVersion: 'v1';
  occurredAt: string;
}
