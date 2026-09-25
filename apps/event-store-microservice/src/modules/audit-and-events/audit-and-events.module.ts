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
