import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { clampPageWindow } from '@retail-inventory-system/common';
import {
  AuditLogEntryView,
  IAuditLogQueryPayload,
  IPage,
} from '@retail-inventory-system/contracts';

import { AUDIT_LOG_REPOSITORY, IAuditLogRepositoryPort } from '../ports';
import { toAuditLogEntryView } from './audit-log-entry-view.factory';

// Query Audit Log Entries: the paginated, filterable read of the append-only
// `audit_log_entry` staff trail (ADR-039). Where its `domain_event` sibling answers "what
// did the system do", this answers "what did a person do" — two questions, two tables, two
// filter sets.
//
// Every filter narrows the scan and every filter names an INDEXED column — `actorId`
// (per-staff-member history), `entityType` + `entityId` (what was done to this resource),
// `action` (every occurrence of this classifier), `correlationId`, and an inclusive
// `occurredAt` window. An absent filter widens it, so an empty filter reads the whole trail,
// newest-first. The opaque `before` / `after` snapshots are returned but never searched.
//
// **Uncached by design**, for the same reason the firehose query is: an operator-driven audit
// read wants the latest rows, and an invalidation hop on every ingest would buy nothing.
//
// An unknown filter value yields an empty page, never a 404 — and so does an inverted
// `from`/`to` range, which the repository's `BETWEEN hi AND lo` evaluates to the empty set.
// The event store therefore grows no `*DomainException` / `*RpcExceptionFilter` pair.
//
// Note the one asymmetry with the firehose log: `audit_log_entry.correlation_id` is genuinely
// nullable (the trail has no dedupe key to defend), so a `correlationId` filter never matches
// a null-correlation row — such rows are reachable only by their other filters.
@Injectable()
export class QueryAuditLogEntriesUseCase {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly repository: IAuditLogRepositoryPort,
    @InjectPinoLogger(QueryAuditLogEntriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IAuditLogQueryPayload): Promise<IPage<AuditLogEntryView>> {
    const { correlationId } = payload;
    // Same reasoning as the page clamp below: this handler is directly reachable on the bus,
    // so `filters` is only guaranteed present by the gateway. An omitted filter set means
    // "no predicate" — the whole trail — not a `TypeError` in the repository.
    const filters = payload.filters ?? {};

    // Clamp the untrusted (page, pageSize) — an RMQ handler is directly reachable, so a
    // malformed page (0, negative, fractional) or an oversized pageSize must be normalized
    // before it reaches the repository's `skip((page - 1) * size)`. This single call IS the
    // "max pageSize 100" rule; it is not duplicated in the gateway DTO.
    const { page, size } = clampPageWindow(payload.page, payload.pageSize, {
      defaultPage: 1,
      defaultSize: 20,
      maxSize: 100,
    });

    this.logger.info(
      { correlationId, filters, page, size },
      'Received RPC: query audit log entries (staff audit read)',
    );

    // The filters cross the seam verbatim — the repository owns both the predicate mapping
    // and the `occurred_at DESC, id DESC` order.
    const entriesPage = await this.repository.query(filters, { page, size });

    return {
      items: entriesPage.items.map(toAuditLogEntryView),
      total: entriesPage.total,
      page: entriesPage.page,
      size: entriesPage.size,
    };
  }
}
