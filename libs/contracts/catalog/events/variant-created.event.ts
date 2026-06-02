import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `catalog.variant.created` event, published by the
// catalog microservice after a variant is persisted. Framework-free — any
// future consumer (a later inventory capability that initialises a zero stock
// level for the new variant) depends on this interface only.
//
// `eventVersion` is pinned to `'v1'`: a breaking change to the payload shape
// ships as `'v2'` so consumers can branch on the version rather than guess from
// the field set. `occurredAt` is an ISO-8601 string — a `DomainEvent` subclass
// is never serialized across services (ADR-011 / ADR-025); the use case maps
// the in-process event to this interface after persistence assigns `variantId`.
export interface ICatalogVariantCreatedEvent extends ICorrelationPayload {
  productId: number;
  variantId: number;
  sku: string;
  eventVersion: 'v1';
  occurredAt: string;
}
