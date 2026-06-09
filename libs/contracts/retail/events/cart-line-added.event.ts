import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.cart.line-added` event, published when a
// variant is added to a cart (or its quantity incremented on an existing line —
// the add-line operation increments rather than duplicating, ADR-028 §1).
// Framework-free — a `DomainEvent` subclass is never serialized across services
// (ADR-011); the cart use case maps the in-process `CartLineAddedEvent` to this
// interface before emitting.
//
// A reserved surface today (no cross-service consumer bound). `variantId` is the
// opaque catalog variant key; `quantity` is the quantity added. `eventVersion`
// is pinned to `'v1'`; `occurredAt` is an ISO-8601 string.
export interface IRetailCartLineAddedEvent extends ICorrelationPayload {
  cartId: string;
  variantId: number;
  quantity: number;
  eventVersion: 'v1';
  occurredAt: string;
}
