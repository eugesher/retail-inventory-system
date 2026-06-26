import { Module } from '@nestjs/common';

// The `domain-events` module of the event store's `audit-and-events` context — the
// sink for the `#.#` event firehose (every business event published in the system).
// It will own the append-only `domain_event` table, its repository, and the firehose
// consumer; those land in later capabilities. It is an empty shell today so the
// service boots and idles with no handlers bound.
@Module({})
export class DomainEventsModule {}
