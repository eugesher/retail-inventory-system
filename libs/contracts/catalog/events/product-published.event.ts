import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `catalog.product.published` event, emitted by the
// catalog microservice after a product transitions `draft → active`. Like every
// catalog wire event it is a plain interface (a `DomainEvent` subclass is never
// serialized across services — ADR-011 / ADR-025); the publish use case drains
// the in-process `ProductPublishedEvent` and maps it to this shape.
//
// `variantIds` are the concrete, persisted variant ids that are now part of the
// published product — the eventual consumer (a later inventory capability that
// initialises a zero stock level per variant) keys on the variant, not the
// product (ADR-025). `publishedAt` is the business timestamp of the transition;
// `occurredAt` is the event-envelope timestamp — both ISO-8601 strings carrying
// the same instant today, kept distinct so a future producer can diverge them
// without a version bump. `eventVersion` is pinned to `'v1'`: a breaking payload
// change ships as `'v2'` so consumers branch on the version rather than guess.
export interface ICatalogProductPublishedEvent extends ICorrelationPayload {
  productId: number;
  slug: string;
  variantIds: number[];
  publishedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
