import { ICorrelationPayload } from '../microservices';

export interface IDomainEventQueryFilters {
  eventType?: string;
  aggregateType?: string;
  aggregateId?: string;
  correlationId?: string;
  from?: string;
  to?: string;
}

export interface IDomainEventQueryPayload extends ICorrelationPayload {
  filters: IDomainEventQueryFilters;
  page?: number;
  pageSize?: number;
}
