import { DomainEventView } from '@retail-inventory-system/contracts';

import { DomainEvent } from '../../domain';

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
