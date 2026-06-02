import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `catalog.product.archived` event, emitted by the
// catalog microservice after a product transitions `active → archived` (the
// catalog's terminal soft-delete — the row stays resolvable by id/slug but is
// hidden from the browse list). A plain interface, never a serialized
// `DomainEvent` subclass (ADR-011 / ADR-025); the archive use case drains the
// in-process `ProductArchivedEvent` and maps it here.
//
// `archivedAt` is the business timestamp of the transition; `occurredAt` is the
// event-envelope timestamp — both ISO-8601 strings carrying the same instant
// today. `eventVersion` is pinned to `'v1'`; a breaking payload change ships as
// `'v2'`.
export interface ICatalogProductArchivedEvent extends ICorrelationPayload {
  productId: number;
  archivedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
