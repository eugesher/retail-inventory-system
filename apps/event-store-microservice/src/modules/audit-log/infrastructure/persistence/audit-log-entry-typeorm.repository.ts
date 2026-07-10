import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { IAuditLogQueryFilters, IPage } from '@retail-inventory-system/contracts';

import { IAuditLogPageRequest, IAuditLogRepositoryPort } from '../../application/ports';
import { AuditLogEntry } from '../../domain';
import { AuditLogEntryEntity } from './audit-log-entry.entity';
import { AuditLogEntryMapper } from './audit-log-entry.mapper';

// An ISO-8601 date-time carrying NO timezone designator (no trailing `Z`, no `±hh:mm`).
// `new Date('2026-06-01T00:00:00')` resolves such a string in the HOST's local zone, while a
// date-ONLY string (`2026-06-01`) resolves as UTC — an ES-spec asymmetry, not a driver one,
// so `DatabaseModule`'s `timezone: 'Z'` pin does not reach it.
const ZONELESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/;

// The wire filter carries ISO-8601 bounds; the column is a `TIMESTAMP(3)` written and read
// as UTC. An absent OR unparseable bound means "no bound" — the gateway DTO (`@IsISO8601()`)
// is the validation gate, so a malformed value can only reach here through a direct RPC,
// where widening the scan is the safe answer (the `ListStockMovementsUseCase.parseInstant`
// precedent).
//
// `@IsISO8601()` ACCEPTS a zone-less date-time, so pin one to UTC before parsing: otherwise
// the window an operator asked for is silently shifted by the event store host's local
// offset, quietly including and excluding rows at both ends. Kept module-local: the sibling
// `domain-events/` repository carries its own copy rather than importing across the
// cross-module isolation line (ADR-017).
function parseInstant(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(ZONELESS_DATE_TIME.test(value) ? `${value}Z` : value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

// The single `@InjectRepository(AuditLogEntryEntity)` site. It implements
// `IAuditLogRepositoryPort` DIRECTLY — deliberately NOT extending
// `BaseTypeormRepository`, whose public `save` / `softDelete` would contradict the
// append-only audit trail (ADR-035). The only mutating verb is `append`, which uses
// `insert`; there is no UPDATE or DELETE expression at the persistence layer. The two reads
// added by the query surface (ADR-039) leave that invariant intact. Returns domain types
// only — no TypeORM leak past this file (ADR-017).
@Injectable()
export class AuditLogEntryTypeormRepository implements IAuditLogRepositoryPort {
  constructor(
    @InjectRepository(AuditLogEntryEntity)
    private readonly auditLogRepository: Repository<AuditLogEntryEntity>,
  ) {}

  public async append(entry: AuditLogEntry): Promise<void> {
    // INSERT, not `save`: an audit entry is born with a null id and is never updated.
    // Audit has no natural dedupe key (two identical staff actions are two real events),
    // so there is no UNIQUE to collide on — every insert is a fresh autoincrement row.
    const partial = AuditLogEntryMapper.toEntity(entry);
    // The cast bridges the mapper's `DeepPartial` to `insert`'s `QueryDeepPartialEntity`
    // — they coincide for scalar columns but diverge on the JSON `before` / `after`
    // snapshots; the mapper already produced a concrete, well-formed row.
    await this.auditLogRepository.insert(partial as QueryDeepPartialEntity<AuditLogEntryEntity>);
  }

  // The paginated audit read (ADR-039). `findAndCount` issues the page SELECT plus the
  // full-match `COUNT(*)` the envelope's `total` needs. Ordering is owned here:
  // `occurred_at DESC, id DESC` — newest-first, `id` totalising the order within a
  // millisecond so a page boundary never drops or repeats a row.
  public async query(
    filters: IAuditLogQueryFilters,
    page: IAuditLogPageRequest,
  ): Promise<IPage<AuditLogEntry>> {
    const where: FindOptionsWhere<AuditLogEntryEntity> = {};
    if (filters.actorId !== undefined) {
      where.actorId = filters.actorId;
    }
    if (filters.entityType !== undefined) {
      where.entityType = filters.entityType;
    }
    if (filters.entityId !== undefined) {
      where.entityId = filters.entityId;
    }
    if (filters.action !== undefined) {
      where.action = filters.action;
    }
    if (filters.correlationId !== undefined) {
      where.correlationId = filters.correlationId;
    }

    // Inclusive `occurred_at` window: both bounds → BETWEEN, one bound → a single half-open
    // comparison. An INVERTED range (`from > to`) yields `BETWEEN hi AND lo`, which MySQL
    // evaluates to the empty set — the deliberate "empty page, not a rejection" answer
    // (ADR-039).
    const from = parseInstant(filters.from);
    const to = parseInstant(filters.to);
    if (from !== undefined && to !== undefined) {
      where.occurredAt = Between(from, to);
    } else if (from !== undefined) {
      where.occurredAt = MoreThanOrEqual(from);
    } else if (to !== undefined) {
      where.occurredAt = LessThanOrEqual(to);
    }

    const [entities, total] = await this.auditLogRepository.findAndCount({
      where,
      order: { occurredAt: 'DESC', id: 'DESC' },
      skip: (page.page - 1) * page.size,
      take: page.size,
    });

    return {
      items: entities.map((entity) => AuditLogEntryMapper.toDomain(entity)),
      total,
      page: page.page,
      size: page.size,
    };
  }

  // The correlation trace read. ASCENDING (`occurred_at ASC, id ASC`) — a timeline reads
  // forward — and unpaginated: a correlation id scopes one request's causal chain, which is
  // bounded and small, so a plain `find` (never `findAndCount`) suffices; there is no page
  // count to report and no `COUNT(*)` to pay for. Served by
  // `IDX_AUDIT_LOG_ENTRY_CORRELATION (correlation_id)`.
  public async listByCorrelationId(correlationId: string): Promise<AuditLogEntry[]> {
    const entities = await this.auditLogRepository.find({
      where: { correlationId },
      order: { occurredAt: 'ASC', id: 'ASC' },
    });
    return entities.map((entity) => AuditLogEntryMapper.toDomain(entity));
  }
}
