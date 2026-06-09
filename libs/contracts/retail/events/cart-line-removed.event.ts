import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.cart.line-removed` event, published when a
// line is dropped from a cart. Framework-free — a `DomainEvent` subclass is never
// serialized across services (ADR-011); the cart use case maps the in-process
// `CartLineRemovedEvent` to this interface before emitting.
//
// A reserved surface today (no cross-service consumer bound). `lineId` is the
// BIGINT `cart_line.id` of the removed line. `eventVersion` is pinned to `'v1'`;
// `occurredAt` is an ISO-8601 string.
export interface IRetailCartLineRemovedEvent extends ICorrelationPayload {
  cartId: string;
  lineId: number;
  eventVersion: 'v1';
  occurredAt: string;
}
