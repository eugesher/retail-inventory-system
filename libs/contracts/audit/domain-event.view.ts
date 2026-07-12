import { ApiResponseProperty } from '@nestjs/swagger';

// One `domain_event` row — the append-only firehose log the event store fills from `ris.events`
// (ADR-035), read back by `audit.event.query` and the correlation trace (ADR-039).
//
// `occurredAt` is an **ISO-8601 string, never a `Date`**. RabbitMQ carries JSON and a `Date` does
// not survive the hop — it arrives as a string regardless, so the contract states that rather than
// typing a lie.
//
// `payload` is the captured event body, returned verbatim and **not searchable**: the query
// filters run on indexed columns only (ADR-039). This field is for reading, never for narrowing.
//
// `correlationId` is typed `string | null` to match the domain model, but a stored row always has
// a string. The column is `NOT NULL DEFAULT ''` so that the ingest dedupe UNIQUE actually collides
// — MySQL treats `NULL`s as distinct inside a UNIQUE, which would let duplicates through. **The
// price is that an event ingested without a correlation id surfaces as `''`, and is then reachable
// by no correlation filter and no trace.**
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
