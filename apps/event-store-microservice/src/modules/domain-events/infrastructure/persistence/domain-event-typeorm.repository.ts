import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { IDomainEventQueryFilters, IPage } from '@retail-inventory-system/contracts';

import {
  IDomainEventAppendResult,
  IDomainEventPageRequest,
  IDomainEventRepositoryPort,
} from '../../application/ports';
import { DomainEvent } from '../../domain';
import { DomainEventEntity } from './domain-event.entity';
import { DomainEventMapper } from './domain-event.mapper';

// MySQL's "duplicate entry for key" error (ER_DUP_ENTRY / errno 1062). A captured
// firehose event whose idempotency tuple collides with an already-stored row surfaces
// this. Duck-typed (not `instanceof QueryFailedError`) because the driver may nest the
// real error under `driverError` — check both levels (the inventory `isDuplicateEntryError`
// precedent, kept local: cross-module isolation forbids importing the inventory util).
const MYSQL_ER_DUP_ENTRY_ERRNO = 1062;
const MYSQL_ER_DUP_ENTRY_CODE = 'ER_DUP_ENTRY';

function isDuplicateEntryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    errno?: number;
    code?: string;
    driverError?: { errno?: number; code?: string };
  };
  const driver = candidate.driverError ?? candidate;
  return driver.errno === MYSQL_ER_DUP_ENTRY_ERRNO || driver.code === MYSQL_ER_DUP_ENTRY_CODE;
}

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
// `audit-log/` repository carries its own copy rather than importing across the cross-module
// isolation line (ADR-017).
function parseInstant(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(ZONELESS_DATE_TIME.test(value) ? `${value}Z` : value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

// The single `@InjectRepository(DomainEventEntity)` site. It implements
// `IDomainEventRepositoryPort` DIRECTLY — deliberately NOT extending
// `BaseTypeormRepository`, whose public `save` / `softDelete` would contradict the
// append-only firehose log (ADR-035). The only mutating verb is `append`, which uses
// `insert` (never `save`-with-id semantics), so an UPDATE or DELETE has no expression
// at the persistence layer either. Returns domain types only — no TypeORM leak past
// this file (ADR-017).
@Injectable()
export class DomainEventTypeormRepository implements IDomainEventRepositoryPort {
  constructor(
    @InjectRepository(DomainEventEntity)
    private readonly domainEventRepository: Repository<DomainEventEntity>,
  ) {}

  public async append(event: DomainEvent): Promise<IDomainEventAppendResult> {
    const partial = DomainEventMapper.toEntity(event);

    // INSERT, not `save`: a captured event is born with a null id and is never updated,
    // so there is no preload-by-id round trip. A collision on the composite-UNIQUE
    // idempotency key `(producer, event_type, aggregate_id, occurred_at, correlation_id)`
    // means a RabbitMQ redelivery of an event already stored — swallow it as an
    // idempotent no-op (`{ inserted: false }`) rather than throwing (the
    // `ReservationTypeormRepository` ER_DUP_ENTRY-translation precedent). Any other
    // failure propagates.
    try {
      // The cast bridges the mapper's `DeepPartial` to `insert`'s
      // `QueryDeepPartialEntity` — they coincide for scalar columns but diverge on the
      // JSON `payload` (which `QueryDeepPartialEntity` widens to allow a SQL expression);
      // the mapper already produced a concrete, well-formed row.
      await this.domainEventRepository.insert(partial as QueryDeepPartialEntity<DomainEventEntity>);
      return { inserted: true };
    } catch (error) {
      if (isDuplicateEntryError(error)) {
        return { inserted: false };
      }
      throw error;
    }
  }

  // The paginated audit read (ADR-039). A READ — the append-only invariant is untouched;
  // `findAndCount` issues the page SELECT plus the full-match `COUNT(*)` the envelope's
  // `total` needs.
  //
  // Ordering is owned here, not by the caller: `occurred_at DESC, id DESC`. The `id`
  // tiebreaker totalises the order when two events share a millisecond, so a page boundary
  // never drops or repeats a row.
  public async query(
    filters: IDomainEventQueryFilters,
    page: IDomainEventPageRequest,
  ): Promise<IPage<DomainEvent>> {
    const where: FindOptionsWhere<DomainEventEntity> = {};
    if (filters.eventType !== undefined) {
      where.eventType = filters.eventType;
    }
    if (filters.aggregateType !== undefined) {
      where.aggregateType = filters.aggregateType;
    }
    if (filters.aggregateId !== undefined) {
      where.aggregateId = filters.aggregateId;
    }
    if (filters.correlationId !== undefined) {
      where.correlationId = filters.correlationId;
    }

    // Inclusive `occurred_at` window: both bounds → BETWEEN, one bound → a single
    // half-open comparison. An INVERTED range (`from > to`) yields `BETWEEN hi AND lo`,
    // which MySQL evaluates to the empty set — the deliberate "empty page, not a rejection"
    // answer (ADR-039), so the event store needs no domain-exception type.
    const from = parseInstant(filters.from);
    const to = parseInstant(filters.to);
    if (from !== undefined && to !== undefined) {
      where.occurredAt = Between(from, to);
    } else if (from !== undefined) {
      where.occurredAt = MoreThanOrEqual(from);
    } else if (to !== undefined) {
      where.occurredAt = LessThanOrEqual(to);
    }

    const [entities, total] = await this.domainEventRepository.findAndCount({
      where,
      order: { occurredAt: 'DESC', id: 'DESC' },
      skip: (page.page - 1) * page.size,
      take: page.size,
    });

    return {
      items: entities.map((entity) => DomainEventMapper.toDomain(entity)),
      total,
      page: page.page,
      size: page.size,
    };
  }
}
