import { ICorrelationPayload } from '../microservices';

import { AuditLogEntryView } from './audit-log-entry.view';
import { DomainEventView } from './domain-event.view';

export interface ICorrelationTracePayload extends ICorrelationPayload {
  targetCorrelationId: string;
}

export interface ICorrelationTraceResult {
  events: DomainEventView[];
  auditEntries: AuditLogEntryView[];
}
