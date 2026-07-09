import { ApiResponseProperty } from '@nestjs/swagger';

// RPC/HTTP response shape for one `domain_event` row — the append-only firehose log the
// event store fills from the `ris.events` topic exchange
// (docs/adr/035-event-store-firehose-topic-exchange.md). Returned by the `audit.event.query`
// RPC and by the correlation trace (docs/adr/039-audit-and-event-store-query-surface.md).
//
// A **class** carrying `@ApiResponseProperty` (the documented lib-contracts Swagger
// exception, ADR-017), mirroring `NotificationDeliveryView` / `StockMovementView`. The
// `naming-convention` lint rule reserves the bare-`interface` form for `I`-prefixed names.
//
// `occurredAt` is an **ISO-8601 string**, never a `Date`: RabbitMQ carries JSON, and a `Date`
// does not survive the hop — it arrives at the gateway as a string anyway, so the contract
// states the truth rather than lying about the type.
//
// `payload` is the opaque captured event body, returned verbatim. It is **not** searchable —
// the query filters operate on indexed columns only (ADR-039); this field is for reading, not
// for narrowing.
//
// `correlationId` is `string | null` to match the domain model, but a stored firehose row
// always carries a string: the column is `NOT NULL DEFAULT ''` so that the ingest dedupe
// UNIQUE actually collides (MySQL treats NULLs as distinct inside a UNIQUE). An event ingested
// without a correlation id therefore surfaces here as `''` — and is unreachable by any
// correlation filter or trace.
export class DomainEventView {
  @ApiResponseProperty()
  public id: number;

  // The full dotted routing key the event was published under, e.g. `retail.order.placed`.
  @ApiResponseProperty()
  public eventType: string;

  @ApiResponseProperty()
  public aggregateType: string;

  @ApiResponseProperty()
  public aggregateId: string;

  // A free-form JSON body: `type: Object` because Swagger cannot infer a schema for an
  // index-signature type.
  @ApiResponseProperty({ type: Object })
  public payload: Record<string, unknown>;

  @ApiResponseProperty()
  public eventVersion: string;

  @ApiResponseProperty()
  public producer: string;

  @ApiResponseProperty()
  public correlationId: string | null;

  @ApiResponseProperty()
  public occurredAt: string;
}
