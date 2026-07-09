import { Module } from '@nestjs/common';

import { AuditQueryController } from './audit-query.controller';
import { AuditLogModule } from './audit-log';
import { DomainEventsModule } from './domain-events';
import { FirehoseConsumer } from './firehose.consumer';

// The `audit-and-events` bounded context aggregates the event store's two sibling
// modules: `domain-events/` (the `#` firehose sink — every business event) and
// `audit-log/` (the staff audit trail). Aggregating them here keeps `app.module.ts`
// importing one context module rather than each sibling (the catalog `app.module.ts`
// two-module precedent, kept to a single import).
//
// It also registers the context's two controllers, both of which live at the context root
// for the same reason: each injects use cases from BOTH sibling modules, and
// `eslint-plugin-boundaries` only lets a module's `infrastructure/` or `presentation/`
// reach its OWN module (the `sameModule` rule). Both siblings export the use cases, which
// this aggregator's import of them makes resolvable.
//
//   - `FirehoseConsumer` — the `@EventPattern('#')` ingest side, on the `ris.events`-bound
//     `event_store_firehose_queue`.
//   - `AuditQueryController` — the three `audit.*` `@MessagePattern` reads, on the
//     default-exchange `event_store_query_queue` (ADR-039).
//
// Both handler sets are registered against BOTH connected transports, because a single Nest
// app binds every handler pattern to every transport. That is harmless in both directions:
// the query transport keeps `wildcards` off, so its exact-match lookup never resolves `#`;
// and the three query routing keys bind onto `ris.events` as inert bindings nobody publishes.
@Module({
  imports: [DomainEventsModule, AuditLogModule],
  controllers: [FirehoseConsumer, AuditQueryController],
})
export class AuditAndEventsModule {}
