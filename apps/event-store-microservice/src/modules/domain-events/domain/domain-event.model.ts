// One immutable row of the event-store firehose log: a captured copy of a business
// event that crossed the `ris.events` topic exchange
// (docs/adr/035-event-store-firehose-topic-exchange.md). The `domain-events` module
// sinks EVERY event the system publishes (the `#.#` firehose), so this model is the
// universal envelope around an opaque `payload` — it is deliberately NOT a typed view
// of any one producer's event.
//
// Framework-free per ADR-004, and a fully **immutable** record in the `StockMovement`
// ledger style (ADR-030 §2): every field is `public readonly`, the constructed
// instance is `Object.freeze`-d, there are NO mutators and NO domain events, and it is
// NOT an `AggregateRoot`. Append-only therefore starts in the type system — a recorded
// event can only be appended and read, never changed.
//
// The model accepts whatever the bus carries — field-level malformed-input rejection
// (drop + warn) is the ingest use case's job, not the model's. The only invariants
// enforced here are the two the column types make load-bearing: a non-empty
// `eventType` and `producer` (the row's identity). An illegal shape is an INTERNAL
// caller bug, so it throws a plain `Error`, deliberately NOT a typed domain exception
// (the `StockMovement.requireSignForType` precedent).

// Full reconstruction shape (the load path). `create` derives `id` and defaults the
// nullable `correlationId`, so its input is the narrower `ICreateDomainEventProps`.
export interface IDomainEventProps {
  id: number | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  eventVersion: string;
  producer: string;
  correlationId: string | null;
  // The producer's emit time, taken from the event payload's `occurredAt` (NOT the
  // ingest time — `received_at` is the DB-assigned ingest instant, not modelled here).
  occurredAt: Date;
}

export interface ICreateDomainEventProps {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  eventVersion: string;
  producer: string;
  correlationId?: string | null;
  occurredAt: Date;
}

export class DomainEvent {
  public readonly id: number | null;
  public readonly eventType: string;
  public readonly aggregateType: string;
  public readonly aggregateId: string;
  public readonly payload: Record<string, unknown>;
  public readonly eventVersion: string;
  public readonly producer: string;
  public readonly correlationId: string | null;
  public readonly occurredAt: Date;

  private constructor(props: IDomainEventProps) {
    // The identity invariant: a firehose row without an event type or a producer is
    // meaningless. These are constructed by the ingest use case from already-shaped
    // wire payloads, so a violation is an INTERNAL bug — a plain `Error`, not a typed
    // exception a filter would surface (the event store has no HTTP/RPC surface).
    DomainEvent.requireNonEmpty(props.eventType, 'eventType');
    DomainEvent.requireNonEmpty(props.producer, 'producer');

    this.id = props.id;
    this.eventType = props.eventType;
    this.aggregateType = props.aggregateType;
    this.aggregateId = props.aggregateId;
    this.payload = props.payload;
    this.eventVersion = props.eventVersion;
    this.producer = props.producer;
    this.correlationId = props.correlationId;
    this.occurredAt = props.occurredAt;

    // `readonly` is compile-time only; freezing makes immutability real at runtime —
    // any write throws in strict mode. This is the runtime half of "append-only starts
    // in the type system".
    Object.freeze(this);
  }

  // The write path: a fresh event with `id: null` (the BIGINT is DB-assigned on
  // append) and `correlationId` defaulting to null when the wire payload carried none.
  public static create(props: ICreateDomainEventProps): DomainEvent {
    return new DomainEvent({
      id: null,
      eventType: props.eventType,
      aggregateType: props.aggregateType,
      aggregateId: props.aggregateId,
      payload: props.payload,
      eventVersion: props.eventVersion,
      producer: props.producer,
      correlationId: props.correlationId ?? null,
      occurredAt: props.occurredAt,
    });
  }

  // The load path: rebuilds a persisted event from storage. The identity invariant is
  // re-asserted (a corrupted stored row is rejected on read, the same defensive posture
  // `StockMovement.reconstitute` takes).
  public static reconstitute(props: IDomainEventProps): DomainEvent {
    return new DomainEvent(props);
  }

  private static requireNonEmpty(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`DomainEvent: ${field} must be a non-empty string`);
    }
  }
}
