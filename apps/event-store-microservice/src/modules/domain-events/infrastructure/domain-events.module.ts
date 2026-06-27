import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import { DOMAIN_EVENT_REPOSITORY } from '../application/ports';
import { DomainEventEntity, DomainEventTypeormRepository } from './persistence';

// The `domain-events` module of the event store's `audit-and-events` context — the
// sink for the `#.#` event firehose (every business event published in the system,
// ADR-035). It owns the append-only `domain_event` table (ADR-034 isolated
// `ris_eventstore` schema).
//
// `DatabaseModule.forFeature([DomainEventEntity])` registers the entity against the
// eventstore connection the app module opened; `DOMAIN_EVENT_REPOSITORY` is bound to
// its append-only TypeORM adapter and EXPORTED so the firehose consumer / ingest use
// case (a later capability) can resolve it. There is no consumer or use case yet — the
// service still boots and idles with no handlers bound.
@Module({
  imports: [DatabaseModule.forFeature([DomainEventEntity])],
  providers: [{ provide: DOMAIN_EVENT_REPOSITORY, useClass: DomainEventTypeormRepository }],
  exports: [DOMAIN_EVENT_REPOSITORY],
})
export class DomainEventsModule {}
