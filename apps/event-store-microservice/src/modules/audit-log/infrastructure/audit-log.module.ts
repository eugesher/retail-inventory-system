import { Module } from '@nestjs/common';

// The `audit-log` module of the event store's `audit-and-events` context — the
// staff audit trail (who did what, when), distinct from the raw event firehose the
// sibling `domain-events/` module sinks. It will own the append-only
// `audit_log_entry` table, its repository, and the audit consumer; those land in
// later capabilities. It is an empty shell today so the service boots and idles with
// no handlers bound.
@Module({})
export class AuditLogModule {}
