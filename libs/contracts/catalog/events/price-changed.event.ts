import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for `catalog.price.changed`, published by the pricing module
// after an **immediate** price is appended (its `validFrom` is at-or-before now,
// so the new amount is in effect immediately). Framework-free — a future consumer
// (an audit / event-store capability) depends on this interface only; a
// `DomainEvent` subclass is never serialized across services (ADR-011 / ADR-020).
//
// The payload carries the resulting open row's full interval shape so a consumer
// needs no read-back: `validFrom`/`validTo` (`null` = open-ended), the
// `amountMinor` minor-units integer, and the `priority` tiebreak. `eventVersion`
// is pinned to `'v1'`: a breaking payload change ships as `'v2'`. `occurredAt` is
// the event-envelope timestamp (ISO-8601).
export interface ICatalogPriceChangedEvent extends ICorrelationPayload {
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom: string;
  validTo: string | null;
  priority: number;
  eventVersion: 'v1';
  occurredAt: string;
}
