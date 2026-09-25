import { ICorrelationPayload } from '../microservices';

export interface IAuditLogQueryFilters {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  correlationId?: string;
  from?: string;
  to?: string;
}

export interface IAuditLogQueryPayload extends ICorrelationPayload {
  filters: IAuditLogQueryFilters;
  page?: number;
  pageSize?: number;
}
