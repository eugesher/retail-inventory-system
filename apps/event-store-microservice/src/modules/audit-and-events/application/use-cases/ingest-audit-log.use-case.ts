import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IAuditStaffActionEvent } from '@retail-inventory-system/contracts';

import { AUDIT_ACTOR_TYPES, AuditLogEntry } from '../../domain';
import { AUDIT_LOG_REPOSITORY, IAuditLogRepositoryPort } from '../ports';

// The ingest path for the staff audit trail: maps one `audit.staff.action` wire event
// (the cross-cutting staff-action stream the firehose consumer routes here, ADR-035) 1:1
// to an append-only `audit_log_entry` row. Distinct from the raw event firehose the
// sibling `domain-events/` module sinks — an audit action lands ONLY in `audit_log_entry`,
// never also in `domain_event`.
//
// Unlike the firehose log there is no composite idempotency key (every staff action is
// its own event — two identical actions a second apart are two genuine rows), so `append`
// always inserts. The crash-safe / never-rethrow posture still holds (ADR-011 §7): a
// payload whose `actorType` is outside the two known origin classes or whose `occurredAt`
// is unparseable is dropped with a warn, and any thrown persist error is caught and
// swallowed — never rethrown from the `@EventPattern`.
@Injectable()
export class IngestAuditLogUseCase {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly repository: IAuditLogRepositoryPort,
    @InjectPinoLogger(IngestAuditLogUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(event: IAuditStaffActionEvent): Promise<void> {
    // `@EventPattern` handlers are not request-scoped, so `correlationId` rides inline.
    const correlationId = event.correlationId ?? '';

    // The audit row's two load-bearing columns are `action` and `actor_type` (the enum).
    // An `actorType` outside `{staff-user, system}` would either fail the model invariant
    // or silently widen the two-value origin axis — drop it with a warn rather than store
    // a meaningless classifier.
    if (!AUDIT_ACTOR_TYPES.includes(event.actorType)) {
      this.logger.warn(
        { correlationId, action: event.action, actorType: event.actorType },
        'Dropping audit event — unknown actorType',
      );
      return;
    }

    // `occurred_at` is the producer action time; an unparseable value cannot be defaulted
    // without falsifying the audit timeline. Warn + drop.
    const occurredAt = this.parseOccurredAt(event.occurredAt);
    if (occurredAt === null) {
      this.logger.warn(
        { correlationId, action: event.action, occurredAt: event.occurredAt },
        'Dropping audit event — missing or invalid occurredAt',
      );
      return;
    }

    try {
      const entry = AuditLogEntry.create({
        actorId: event.actorId,
        actorType: event.actorType,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        before: event.before,
        after: event.after,
        occurredAt,
        ipAddress: event.ipAddress,
        correlationId,
      });

      await this.repository.append(entry);

      this.logger.debug(
        { correlationId, action: event.action, actorId: event.actorId },
        'Audit entry appended to audit_log_entry',
      );
    } catch (error) {
      // Caught and swallowed — never rethrown from the consumer's `@EventPattern`
      // (ADR-011 §7). The message is acked.
      this.logger.warn(
        { err: error as Error, correlationId, action: event.action },
        'Failed to ingest audit event — dropping message',
      );
    }
  }

  // Parse the wire ISO-8601 `occurredAt` into a `Date`, returning null for an absent,
  // non-string, or unparseable value.
  private parseOccurredAt(raw: unknown): Date | null {
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
