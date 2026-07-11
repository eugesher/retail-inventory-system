import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import { AUDIT_LOG_REPOSITORY, DOMAIN_EVENT_REPOSITORY } from './application/ports';
import {
  IngestAuditLogUseCase,
  IngestDomainEventUseCase,
  QueryAuditLogEntriesUseCase,
  QueryDomainEventsUseCase,
  TraceByCorrelationUseCase,
} from './application/use-cases';
import {
  auditAndEventsEntities,
  AuditLogEntryTypeormRepository,
  DomainEventTypeormRepository,
} from './infrastructure/persistence';
import { AuditQueryController, FirehoseConsumer } from './presentation';

// The `audit-and-events` bounded context — ONE module, two append-only logs (ADR-042).
//
//   - `domain_event`   — the `#` firehose sink: every business event the system published.
//   - `audit_log_entry` — the staff audit trail: what a person did.
//
// They are two aggregates in one context, not two contexts, so they are two repository ports
// inside one module — the `modules/orders/` precedent (five aggregates, five ports, one
// module). Both tables live in the isolated `ris_eventstore` schema on the single connection
// `app.module.ts` opens (ADR-034); `DatabaseModule.forFeature` registers both entities
// against it.
//
// `TraceByCorrelationUseCase` is why the decomposition matters: it must read BOTH logs for
// one request, and with both repositories in scope it simply injects them. The earlier
// two-module split forced that read through a raw-SQL reader port over the sibling's table —
// see ADR-042 for what collapsing the split deleted.
//
// Both controllers are ordinary `presentation/` members of this module. Their handler sets
// are registered against BOTH connected transports, because a single Nest app binds every
// handler pattern to every transport; that is harmless in both directions (ADR-039):
//
//   - `FirehoseConsumer` — `@EventPattern('#')` ingest, on the `ris.events`-bound
//     `event_store_firehose_queue`.
//   - `AuditQueryController` — the three `audit.*` `@MessagePattern` reads, on the
//     default-exchange `event_store_query_queue`, whose `wildcards: false` exact-match lookup
//     never resolves `#`.
@Module({
  imports: [DatabaseModule.forFeature(auditAndEventsEntities)],
  controllers: [FirehoseConsumer, AuditQueryController],
  providers: [
    { provide: DOMAIN_EVENT_REPOSITORY, useClass: DomainEventTypeormRepository },
    { provide: AUDIT_LOG_REPOSITORY, useClass: AuditLogEntryTypeormRepository },
    IngestDomainEventUseCase,
    QueryDomainEventsUseCase,
    IngestAuditLogUseCase,
    QueryAuditLogEntriesUseCase,
    TraceByCorrelationUseCase,
  ],
})
export class AuditAndEventsModule {}
