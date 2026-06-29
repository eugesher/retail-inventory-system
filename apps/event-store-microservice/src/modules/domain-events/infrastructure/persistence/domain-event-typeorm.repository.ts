import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Repository } from 'typeorm';

import { IDomainEventAppendResult, IDomainEventRepositoryPort } from '../../application/ports';
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

  public async listByCorrelationId(correlationId: string): Promise<DomainEvent[]> {
    // Newest-first; the `id DESC` tiebreaker makes the order total when two rows share
    // an `occurred_at`. A read — the append-only invariant is untouched.
    const entities = await this.domainEventRepository.find({
      where: { correlationId },
      order: { occurredAt: 'DESC', id: 'DESC' },
    });
    return entities.map((entity) => DomainEventMapper.toDomain(entity));
  }
}
