import { DeepPartial } from 'typeorm';

import { DomainEvent } from '../../domain';
import { DomainEventEntity } from './domain-event.entity';

export class DomainEventMapper {
  public static toDomain(entity: DomainEventEntity): DomainEvent {
    return DomainEvent.reconstitute({
      // The BIGINT PK comes back from the mysql2 driver as a string; coerce to a
      // number (the `StockMovementMapper` precedent, ADR-019).
      id: Number(entity.id),
      eventType: entity.eventType,
      aggregateType: entity.aggregateType,
      aggregateId: entity.aggregateId,
      payload: entity.payload,
      eventVersion: entity.eventVersion,
      producer: entity.producer,
      correlationId: entity.correlationId ?? null,
      occurredAt: entity.occurredAt,
    });
  }

  public static toEntity(domain: DomainEvent): DeepPartial<DomainEventEntity> {
    // `id` (DB-assigned) and `received_at` (DB-defaulted to the ingest instant) are
    // deliberately omitted — they are written by the database, never by the mapper.
    // There is no update path: a captured event is immutable once appended.
    return {
      eventType: domain.eventType,
      aggregateType: domain.aggregateType,
      aggregateId: domain.aggregateId,
      payload: domain.payload,
      eventVersion: domain.eventVersion,
      producer: domain.producer,
      correlationId: domain.correlationId,
      occurredAt: domain.occurredAt,
    };
  }
}
