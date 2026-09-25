import {
  AuditLogEntryView,
  DomainEventView,
  IAuditLogQueryFilters,
  IAuditLogQueryPayload,
  ICorrelationTracePayload,
  ICorrelationTraceResult,
  IDomainEventQueryFilters,
  IDomainEventQueryPayload,
  IPage,
} from '@retail-inventory-system/contracts';

export const AUDIT_GATEWAY_PORT = Symbol('AUDIT_GATEWAY_PORT');

export interface IQueryEventsQuery {
  filters: IDomainEventQueryFilters;
  page?: number;
  pageSize?: number;
}

export interface IQueryEntriesQuery {
  filters: IAuditLogQueryFilters;
  page?: number;
  pageSize?: number;
}

export interface ITraceByCorrelationQuery {
  targetCorrelationId: string;
}

export interface IAuditGatewayPort {
  queryEvents(payload: IDomainEventQueryPayload): Promise<IPage<DomainEventView>>;
  queryEntries(payload: IAuditLogQueryPayload): Promise<IPage<AuditLogEntryView>>;
  traceByCorrelation(payload: ICorrelationTracePayload): Promise<ICorrelationTraceResult>;
}
