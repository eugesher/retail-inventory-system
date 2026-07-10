import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { ITraceDomainEventReaderPort, ITraceDomainEventRow } from '../../application/ports';

// The mysql2 row shape for the trace read. Aliasing the snake_case columns to camelCase
// keeps the projection mapping off `any` without an assertion (ADR-017's no-unsafe-* rules).
// The BIGINT `id` surfaces as a string, so the mapper coerces. `payload` is a JSON column:
// mysql2 hands back an already-parsed object — but a driver configured otherwise, or a row
// written by a tool that stored a JSON string, would hand back a string, so the mapper
// guards the shape rather than trusting it.
interface IDomainEventRow {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  eventVersion: string;
  producer: string;
  correlationId: string | null;
  occurredAt: Date | string;
}

// The audit-log context's read seam onto the `domain_event` table. That table belongs to the
// SIBLING `domain-events/` module, behind a hard cross-module isolation line — the
// boundaries lint forbids this module from importing `DomainEventEntity` or injecting that
// module's repository-port token (ADR-017). So this adapter reaches the table with
// PARAMETERIZED SQL through the injected `EntityManager`, exactly as the notification service reaches the
// gateway-owned `consent_record` (`ConsentReaderTypeormAdapter`) and the returns module
// reaches the `order` tables (`ReturnOrderReaderTypeormAdapter`). The table name is the only
// coupling; the `?` placeholder is bound by the driver, never string-concatenated.
//
// `@InjectEntityManager()` resolves the DEFAULT connection — the event store opens exactly
// one, `EVENTSTORE_DATABASE_URL` → `ris_eventstore` (ADR-034), which is the schema both
// sibling modules live in. No second connection, no cross-database join.
//
// `domain_event` is append-only and carries no `deleted_at` at all (unlike the `BaseEntity`
// tables the other reader adapters read), so — unlike them — there is no soft-delete filter
// to add.
@Injectable()
export class TraceDomainEventReader implements ITraceDomainEventReaderPort {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  public async listByCorrelationId(correlationId: string): Promise<ITraceDomainEventRow[]> {
    // ASCENDING — a trace is a timeline and reads forward — with the `id` tiebreaker
    // totalising the order for two events that share a millisecond. Served by
    // `IDX_DOMAIN_EVENT_CORRELATION (correlation_id)`. An unknown id yields zero rows, which
    // maps to `[]`, never an error.
    const rows = await this.entityManager.query<IDomainEventRow[]>(
      `SELECT id,
              event_type     AS eventType,
              aggregate_type AS aggregateType,
              aggregate_id   AS aggregateId,
              payload,
              event_version  AS eventVersion,
              producer,
              correlation_id AS correlationId,
              occurred_at    AS occurredAt
         FROM domain_event
        WHERE correlation_id = ?
        ORDER BY occurred_at ASC, id ASC`,
      [correlationId],
    );

    return rows.map((row) => ({
      id: Number(row.id),
      eventType: row.eventType,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      payload: TraceDomainEventReader.toPayload(row.payload),
      eventVersion: row.eventVersion,
      producer: row.producer,
      correlationId: row.correlationId,
      occurredAt: TraceDomainEventReader.toDate(row.occurredAt),
    }));
  }

  // The JSON column normally arrives pre-parsed. Guard both the string case (parse it) and
  // the non-object case (an array, a bare scalar, or malformed JSON) — the row shape the
  // trace promises is a `Record<string, unknown>`, and a corrupted `payload` must not crash
  // the whole trace.
  private static toPayload(value: unknown): Record<string, unknown> {
    const candidate = typeof value === 'string' ? TraceDomainEventReader.tryParse(value) : value;
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      return {};
    }
    return candidate as Record<string, unknown>;
  }

  private static tryParse(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  // mysql2 returns a `Date` for a TIMESTAMP column (the driver is pinned to UTC), but a raw
  // query on some driver configurations surfaces it as a string — `new Date(...)` handles
  // both (the `ReturnOrderReaderTypeormAdapter.toDate` precedent).
  private static toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
  }
}
