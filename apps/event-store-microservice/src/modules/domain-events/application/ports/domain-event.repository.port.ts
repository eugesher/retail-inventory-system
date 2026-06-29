import { DomainEvent } from '../../domain';

export const DOMAIN_EVENT_REPOSITORY = Symbol('DOMAIN_EVENT_REPOSITORY');

// The outcome of an append: `inserted` is `true` when the row was written, `false`
// when the composite-UNIQUE idempotency key collided with an already-stored event
// (a RabbitMQ redelivery — ADR-020 is at-least-once). The caller never sees a thrown
// duplicate; the swallow is the idempotency guarantee.
export interface IDomainEventAppendResult {
  inserted: boolean;
}

// The ENTIRE repository surface for the firehose log — `append` plus the future read,
// and NOTHING else. There is deliberately no `save` / `update` / `delete`: the
// `domain_event` log is append-only (the audit-integrity / "never delete, never
// update" cross-cutting rule), and that invariant is enforced HERE, in the port's
// type surface, not merely by convention — an UPDATE or DELETE is not expressible
// against this seam. Domain types only — no `typeorm` leak (ADR-017).
export interface IDomainEventRepositoryPort {
  // INSERT a captured firehose event. On the composite-UNIQUE
  // `(producer, event_type, aggregate_id, occurred_at, correlation_id)` collision the
  // implementation returns `{ inserted: false }` (an idempotent no-op — the
  // `ReservationTypeormRepository` `ER_DUP_ENTRY`-translation precedent), never
  // throwing, so a redelivery is silently absorbed.
  append(event: DomainEvent): Promise<IDomainEventAppendResult>;

  // Newest-first events sharing a correlation id — the future cross-service-trace
  // read path. Declared now so the seam is complete (the `StockMovement.listByVariant`
  // precedent); a read, so the append-only invariant is untouched. No HTTP/RPC
  // endpoint is built against it in this capability.
  listByCorrelationId(correlationId: string): Promise<DomainEvent[]>;
}
