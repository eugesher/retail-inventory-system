import { DataSource } from 'typeorm';

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

  public async countDomainEventsByEventType(eventType: string): Promise<number> {
    const rows: Record<string, unknown>[] = await this.query(
      `SELECT COUNT(*) AS n FROM domain_event WHERE event_type = ?;`,
      [eventType],
    );
    return Number(rows[0].n);
  }

  public async countDomainEventsByTypeAndAggregateId(
    eventType: string,
    aggregateId: string,
  ): Promise<number> {
    const rows: Record<string, unknown>[] = await this.query(
      `SELECT COUNT(*) AS n FROM domain_event WHERE event_type = ? AND aggregate_id = ?;`,
      [eventType, aggregateId],
    );
    return Number(rows[0].n);
  }

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
