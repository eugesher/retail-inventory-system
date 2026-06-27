import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { MessagingModule } from '@retail-inventory-system/messaging';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { AuditLogEntryEntity } from '../modules/audit-log';
import { AuditAndEventsModule } from '../modules/audit-and-events.module';
import { DomainEventEntity } from '../modules/domain-events';

// The event-store microservice — the sixth deployable — persists the event firehose
// and the staff audit log to an ISOLATED logical database `ris_eventstore` (ADR-034),
// not the shared operational `retail_db` the other five services join (the contrast
// with the notification service's shared-DB choice, ADR-033). The write-heavy `#.#`
// firehose must not pressure live checkout/inventory reads, so it gets its own schema
// + migration history + connection.
//
// `DatabaseModule.forRootWithUrl([...], 'EVENTSTORE_DATABASE_URL')` opens that second
// connection — `synchronize` off (ADR-019). It registers the two append-only entities
// the context owns (`DomainEventEntity` → `domain_event`, `AuditLogEntryEntity` →
// `audit_log_entry`); the matching tables are created by the eventstore migration
// pipeline (`migration:run:eventstore`). The `AuditAndEventsModule` aggregates the two
// context modules (`domain-events/` + `audit-log/`), each of which binds its repository
// port via `DatabaseModule.forFeature`. The service still boots and idles with no
// handlers bound until the firehose consumer is wired (a later capability).
@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.EVENT_STORE_MICROSERVICE)),
    DatabaseModule.forRootWithUrl(
      [DomainEventEntity, AuditLogEntryEntity],
      'EVENTSTORE_DATABASE_URL',
    ),
    MessagingModule,
    AuditAndEventsModule,
  ],
})
export class AppModule {}
