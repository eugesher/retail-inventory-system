import { DeepPartial } from 'typeorm';

import { DomainEvent } from '../../domain';
import { DomainEventEntity } from './domain-event.entity';

export class DomainEventMapper {
  public static toDomain(entity: DomainEventEntity): DomainEvent {
    return DomainEvent.reconstitute({
      id: Number(entity.id),
      eventType: entity.eventType,
      aggregateType: entity.aggregateType,
      aggregateId: entity.aggregateId,
      payload: entity.payload,
      eventVersion: entity.eventVersion,
      producer: entity.producer,
      correlationId: entity.correlationId,
      occurredAt: entity.occurredAt,
    });
  }

  public static toEntity(domain: DomainEvent): DeepPartial<DomainEventEntity> {
    return {
      eventType: domain.eventType,
      aggregateType: domain.aggregateType,
      aggregateId: domain.aggregateId,
      payload: domain.payload,
      eventVersion: domain.eventVersion,
      producer: domain.producer,
      correlationId: domain.correlationId ?? '',
      occurredAt: domain.occurredAt,
    };
  }
}
