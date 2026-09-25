import { IAuditLogQueryFilters, IPage } from '@retail-inventory-system/contracts';

import { AuditLogEntry } from '../../domain';

export const AUDIT_LOG_REPOSITORY = Symbol('AUDIT_LOG_REPOSITORY');

export interface IAuditLogPageRequest {
  page: number;
  size: number;
}

export interface IAuditLogRepositoryPort {
  append(entry: AuditLogEntry): Promise<void>;

  query(filters: IAuditLogQueryFilters, page: IAuditLogPageRequest): Promise<IPage<AuditLogEntry>>;

  listByCorrelationId(correlationId: string): Promise<AuditLogEntry[]>;
}
