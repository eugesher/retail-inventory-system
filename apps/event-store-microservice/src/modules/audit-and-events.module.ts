import { Module } from '@nestjs/common';

import { AuditLogModule } from './audit-log';
import { DomainEventsModule } from './domain-events';

// The `audit-and-events` bounded context aggregates the event store's two sibling
// modules: `domain-events/` (the `#.#` firehose sink — every business event) and
// `audit-log/` (the staff audit trail). Both are empty shells today; the tables,
// repositories, consumers, and use cases land in later capabilities. Aggregating them
// here keeps `app.module.ts` importing one context module rather than each sibling
// (the catalog `app.module.ts` two-module precedent, kept to a single import).
@Module({
  imports: [DomainEventsModule, AuditLogModule],
})
export class AuditAndEventsModule {}
