import { AuditLogEntryEntity } from './audit-log-entry.entity';
import { DomainEventEntity } from './domain-event.entity';

// The module's entity list: `DatabaseModule.forRootWithUrl(...)` in `app.module.ts` — the
// event store's own `ris_eventstore` connection, not the shared one (ADR-034) — and
// `forFeature(...)` in the module file. UNANNOTATED on purpose — see the note on
// `DatabaseModule.forRoot` for why the parameter type must not be used here.
export const auditAndEventsEntities = [DomainEventEntity, AuditLogEntryEntity];

export { AuditLogEntryEntity } from './audit-log-entry.entity';
export * from './audit-log-entry.mapper';
export * from './audit-log-entry-typeorm.repository';
export { DomainEventEntity } from './domain-event.entity';
export * from './domain-event.mapper';
export * from './domain-event-typeorm.repository';
