import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import { AUDIT_LOG_REPOSITORY } from '../application/ports';
import { AuditLogEntryEntity, AuditLogEntryTypeormRepository } from './persistence';

// The `audit-log` module of the event store's `audit-and-events` context — the staff
// audit trail (who did what, when, ADR-035), distinct from the raw event firehose the
// sibling `domain-events/` module sinks. It owns the append-only `audit_log_entry`
// table (ADR-034 isolated `ris_eventstore` schema).
//
// `DatabaseModule.forFeature([AuditLogEntryEntity])` registers the entity against the
// eventstore connection; `AUDIT_LOG_REPOSITORY` is bound to its append-only TypeORM
// adapter and EXPORTED so the audit-ingest use case (a later capability) can resolve
// it. There is no consumer or use case yet — the service still boots and idles with no
// handlers bound.
@Module({
  imports: [DatabaseModule.forFeature([AuditLogEntryEntity])],
  providers: [{ provide: AUDIT_LOG_REPOSITORY, useClass: AuditLogEntryTypeormRepository }],
  exports: [AUDIT_LOG_REPOSITORY],
})
export class AuditLogModule {}
