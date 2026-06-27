import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import { IngestDomainEventUseCase } from '../application/use-cases';
import { DOMAIN_EVENT_REPOSITORY } from '../application/ports';
import { DomainEventEntity, DomainEventTypeormRepository } from './persistence';

// The `domain-events` module of the event store's `audit-and-events` context — the
// sink for the `#.#` event firehose (every business event published in the system,
// ADR-035). It owns the append-only `domain_event` table (ADR-034 isolated
// `ris_eventstore` schema).
//
// `DatabaseModule.forFeature([DomainEventEntity])` registers the entity against the
// eventstore connection the app module opened; `DOMAIN_EVENT_REPOSITORY` is bound to
// its append-only TypeORM adapter. `IngestDomainEventUseCase` is provided AND EXPORTED so
// the context-root `FirehoseConsumer` (which spans both sibling modules) can inject it —
// the use case stays inside its owning module, the cross-module dispatcher resolves it
// through this export.
@Module({
  imports: [DatabaseModule.forFeature([DomainEventEntity])],
  providers: [
    { provide: DOMAIN_EVENT_REPOSITORY, useClass: DomainEventTypeormRepository },
    IngestDomainEventUseCase,
  ],
  exports: [DOMAIN_EVENT_REPOSITORY, IngestDomainEventUseCase],
})
export class DomainEventsModule {}
