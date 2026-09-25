import { IDomainEventQueryFilters, IPage } from '@retail-inventory-system/contracts';

import { DomainEvent } from '../../domain';

export const DOMAIN_EVENT_REPOSITORY = Symbol('DOMAIN_EVENT_REPOSITORY');

export interface IDomainEventAppendResult {
  inserted: boolean;
}

export interface IDomainEventPageRequest {
  page: number;
  size: number;
}

export interface IDomainEventRepositoryPort {
  append(event: DomainEvent): Promise<IDomainEventAppendResult>;

  query(
    filters: IDomainEventQueryFilters,
    page: IDomainEventPageRequest,
  ): Promise<IPage<DomainEvent>>;

  listByCorrelationId(correlationId: string): Promise<DomainEvent[]>;
}
