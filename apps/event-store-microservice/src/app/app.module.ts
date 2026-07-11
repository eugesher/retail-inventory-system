import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { MessagingModule } from '@retail-inventory-system/messaging';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { auditAndEventsEntities, AuditAndEventsModule } from '../modules/audit-and-events';

// The event-store microservice — the sixth deployable — persists the event firehose
// and the staff audit log to an ISOLATED logical database `ris_eventstore` (ADR-034),
// not the shared operational `retail_db` the other five services join (the contrast
// with the notification service's shared-DB choice, ADR-033). The write-heavy `#`
// firehose must not pressure live checkout/inventory reads, so it gets its own schema
// + migration history + connection.
//
// `DatabaseModule.forRootWithUrl(auditAndEventsEntities, 'EVENTSTORE_DATABASE_URL')` opens
// that second connection — `synchronize` off (ADR-019). It registers the two append-only
// entities the context owns (`DomainEventEntity` → `domain_event`, `AuditLogEntryEntity` →
// `audit_log_entry`); the matching tables are created by the eventstore migration
// pipeline (`migration:run:eventstore`). `AuditAndEventsModule` is the context's single
// module (ADR-042): it binds both repository ports via `DatabaseModule.forFeature` and
// registers the `FirehoseConsumer` that binds the `event_store_firehose_queue` (`#`) to
// `ris.events` and ingests the whole firehose.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.EVENT_STORE_MICROSERVICE)),
    DatabaseModule.forRootWithUrl(auditAndEventsEntities, 'EVENTSTORE_DATABASE_URL'),
    MessagingModule,
    AuditAndEventsModule,
  ],
})
export class AppModule {}
