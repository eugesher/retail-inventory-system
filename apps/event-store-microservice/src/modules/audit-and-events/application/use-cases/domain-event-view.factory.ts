import { DomainEventView } from '@retail-inventory-system/contracts';

import { DomainEvent } from '../../domain';

// Pure mapping from the frozen `DomainEvent` record onto the wire `DomainEventView`
// (ADR-039). Kept framework-free so the projection lives in exactly one place — the
// `toNotificationDeliveryView` / `toStockMovementView` factory pattern.
//
// The record is always persisted when it reaches the factory (the query use case maps only
// post-`query` rows), so `id` is concrete — the `!` reflects that invariant.
//
// `occurredAt` becomes an ISO-8601 string: a `Date` does not survive the RabbitMQ JSON hop
// intact, so the wire contract states the truth.
//
// `correlationId` is passed through VERBATIM, including the empty string. `''` is what a
// firehose row ingested without a correlation id actually stores — the column is
// `NOT NULL DEFAULT ''` so the ingest dedupe UNIQUE collides (MySQL treats NULLs as distinct
// inside a UNIQUE). Silently rewriting `''` to `null` here would hide that storage fact from
// the one surface that can observe it.
export const toDomainEventView = (event: DomainEvent): DomainEventView => ({
  id: event.id!,
  eventType: event.eventType,
  aggregateType: event.aggregateType,
  aggregateId: event.aggregateId,
  payload: event.payload,
  eventVersion: event.eventVersion,
  producer: event.producer,
  correlationId: event.correlationId,
  occurredAt: event.occurredAt.toISOString(),
});
