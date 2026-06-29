import { Module } from '@nestjs/common';

import { AuditLogModule } from './audit-log';
import { DomainEventsModule } from './domain-events';
import { FirehoseConsumer } from './firehose.consumer';

// The `audit-and-events` bounded context aggregates the event store's two sibling
// modules: `domain-events/` (the `#.#` firehose sink — every business event) and
// `audit-log/` (the staff audit trail). Aggregating them here keeps `app.module.ts`
// importing one context module rather than each sibling (the catalog `app.module.ts`
// two-module precedent, kept to a single import).
//
// It also registers the single `FirehoseConsumer` controller. The consumer dispatches
// the `ris.events` firehose into BOTH sibling modules' ingest use cases, so it belongs to
// the context, not to either module — it lives here at the context root (the only place
// it can inject across both modules without crossing an `eslint-plugin-boundaries`
// `sameModule` line). Both sibling modules export their ingest use case, which this
// aggregator's import of them makes resolvable to the consumer.
@Module({
  imports: [DomainEventsModule, AuditLogModule],
  controllers: [FirehoseConsumer],
})
export class AuditAndEventsModule {}
