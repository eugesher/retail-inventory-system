import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import { IngestAuditLogUseCase } from '../application/use-cases';
import { AUDIT_LOG_REPOSITORY } from '../application/ports';
import { AuditLogEntryEntity, AuditLogEntryTypeormRepository } from './persistence';

// The `audit-log` module of the event store's `audit-and-events` context — the staff
// audit trail (who did what, when, ADR-035), distinct from the raw event firehose the
// sibling `domain-events/` module sinks. It owns the append-only `audit_log_entry`
// table (ADR-034 isolated `ris_eventstore` schema).
//
// `DatabaseModule.forFeature([AuditLogEntryEntity])` registers the entity against the
// eventstore connection; `AUDIT_LOG_REPOSITORY` is bound to its append-only TypeORM
// adapter. `IngestAuditLogUseCase` is provided AND EXPORTED so the context-root
// `FirehoseConsumer` can inject it for the `audit.staff.action` branch of its dispatch —
// the use case stays inside its owning module, the cross-module dispatcher resolves it
// through this export.
@Module({
  imports: [DatabaseModule.forFeature([AuditLogEntryEntity])],
  providers: [
    { provide: AUDIT_LOG_REPOSITORY, useClass: AuditLogEntryTypeormRepository },
    IngestAuditLogUseCase,
  ],
  exports: [AUDIT_LOG_REPOSITORY, IngestAuditLogUseCase],
})
export class AuditLogModule {}
