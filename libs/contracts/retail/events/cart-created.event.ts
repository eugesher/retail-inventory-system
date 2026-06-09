import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.cart.created` event, published by the retail
// microservice when a shopper opens a new cart. Framework-free — a `DomainEvent`
// subclass is never serialized across services (ADR-011); the cart use case maps
// the in-process `CartCreatedEvent` to this interface before emitting.
//
// A reserved surface today: it is emitted onto `retail_queue` (the retail
// service's own queue) with no cross-service consumer bound yet — the same
// reserved-surface pattern the `catalog.*` / `inventory.stock.*` events follow.
// `cartId` is the CHAR(36) UUID; `customerId` is the gateway customer UUID or
// `null` for a guest cart. `eventVersion` is pinned to `'v1'`; a breaking payload
// change ships as `'v2'`. `occurredAt` is an ISO-8601 string.
export interface IRetailCartCreatedEvent extends ICorrelationPayload {
  cartId: string;
  customerId: string | null;
  currency: string;
  eventVersion: 'v1';
  occurredAt: string;
}
