import { DataSource } from 'typeorm';

// E2E helper for the event-store suites. Unlike the other `*.e2e-spec.data-source.ts`
// helpers — which open on `DATABASE_URL` (the operational `retail_db`) — this one is
// opened by its suite on `EVENTSTORE_DATABASE_URL`, the isolated `ris_eventstore`
// schema (ADR-034) that holds the two append-only firehose logs. It therefore extends
// `DataSource` directly rather than `InventoryAutoInitE2ESpecDataSource`, whose
// `stock_level` reader targets a table that does not exist here.
//
// The event store has no query endpoint (a deferred capability), so a direct row read
// is the only way to prove what the firehose ingest persisted. Both logs are written
// asynchronously off the bus, so suites poll these readers (re-query with a short delay
// up to a bounded timeout) rather than asserting immediately after the HTTP call.
//
// mysql2 returns BIGINT `id` columns as strings and already parses `json` columns to
// objects, so `id` is coerced with `Number(...)` and `payload`/`before`/`after` are
// passed through as objects. `occurred_at` is returned as a `Date`; the connection is
// pinned to UTC (`timezone: 'Z'`, matching the writer's `DatabaseModule`) so the
// wall-clock the producer emitted round-trips unshifted.

// One `domain_event` row, projected to the fields the firehose / idempotency suites
// assert on. `payload` is the whole captured wire event; the resolver-derived columns
// (`producer`, `aggregate_type`, `aggregate_id`) and the idempotency anchor
// (`correlation_id` + `occurred_at`) are surfaced for direct assertion.
export interface IDomainEventRowProjection {
  id: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  producer: string;
  correlationId: string | null;
  eventVersion: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

// One `audit_log_entry` row, projected to the fields the audit-log suite asserts on.
export interface IAuditLogEntryRowProjection {
  id: number;
  actorId: string | null;
  actorType: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  correlationId: string | null;
  occurredAt: Date;
}

export class EventStoreE2ESpecDataSource extends DataSource {
  private static toDomainEventRow(row: Record<string, unknown>): IDomainEventRowProjection {
    return {
      id: Number(row.id),
      eventType: String(row.event_type),
      aggregateType: String(row.aggregate_type),
      aggregateId: String(row.aggregate_id),
      producer: String(row.producer),
      correlationId: (row.correlation_id as string | null) ?? null,
      eventVersion: String(row.event_version),
      occurredAt: row.occurred_at as Date,
      payload: row.payload as Record<string, unknown>,
    };
  }

  private static readonly DOMAIN_EVENT_COLUMNS = `
    id, event_type, aggregate_type, aggregate_id, producer,
    correlation_id, event_version, occurred_at, payload
  `;

  // Every domain event the firehose captured under one correlation id, oldest first —
  // the whole Place Order chain when the suite drives the flow under a fixed
  // `x-correlation-id` header.
  public async getDomainEventsByCorrelationId(
    correlationId: string,
  ): Promise<IDomainEventRowProjection[]> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT ${EventStoreE2ESpecDataSource.DOMAIN_EVENT_COLUMNS}
        FROM domain_event
        WHERE correlation_id = ?
        ORDER BY occurred_at ASC, id ASC;
      `,
      [correlationId],
    );
    return rows.map((row) => EventStoreE2ESpecDataSource.toDomainEventRow(row));
  }

  public async countDomainEventsByCorrelationId(correlationId: string): Promise<number> {
    const rows: Record<string, unknown>[] = await this.query(
      `SELECT COUNT(*) AS n FROM domain_event WHERE correlation_id = ?;`,
      [correlationId],
    );
    return Number(rows[0].n);
  }

  // Used to prove `audit.staff.action` never lands in `domain_event` (it routes only to
  // `audit_log_entry`).
  public async countDomainEventsByEventType(eventType: string): Promise<number> {
    const rows: Record<string, unknown>[] = await this.query(
      `SELECT COUNT(*) AS n FROM domain_event WHERE event_type = ?;`,
      [eventType],
    );
    return Number(rows[0].n);
  }

  // Exactly the composite UNIQUE `(producer, event_type, aggregate_id, occurred_at,
  // correlation_id)` — the idempotency anchor. A double-publish of the same wire event
  // must leave this at 1.
  public async countDomainEventsByCompositeKey(key: {
    producer: string;
    eventType: string;
    aggregateId: string;
    occurredAt: string;
    correlationId: string;
  }): Promise<number> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT COUNT(*) AS n
        FROM domain_event
        WHERE producer = ?
          AND event_type = ?
          AND aggregate_id = ?
          AND occurred_at = ?
          AND correlation_id = ?;
      `,
      [key.producer, key.eventType, key.aggregateId, key.occurredAt, key.correlationId],
    );
    return Number(rows[0].n);
  }

  // Every staff audit entry under one correlation id, newest first.
  public async getAuditLogEntriesByCorrelationId(
    correlationId: string,
  ): Promise<IAuditLogEntryRowProjection[]> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT id, actor_id, actor_type, action, entity_type, entity_id,
               \`before\`, \`after\`, ip_address, correlation_id, occurred_at
        FROM audit_log_entry
        WHERE correlation_id = ?
        ORDER BY id DESC;
      `,
      [correlationId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      actorId: (row.actor_id as string | null) ?? null,
      actorType: String(row.actor_type),
      action: String(row.action),
      entityType: (row.entity_type as string | null) ?? null,
      entityId: (row.entity_id as string | null) ?? null,
      before: (row.before as Record<string, unknown> | null) ?? null,
      after: (row.after as Record<string, unknown> | null) ?? null,
      ipAddress: (row.ip_address as string | null) ?? null,
      correlationId: (row.correlation_id as string | null) ?? null,
      occurredAt: row.occurred_at as Date,
    }));
  }
}
