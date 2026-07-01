import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import {
  IDEMPOTENCY_KEY_TTL_HOURS,
  IIdempotencyRecord,
  IIdempotencyRecordInput,
  IIdempotencyStorePort,
  ITransactionScope,
} from '../../application/ports';
import { IdempotencyKeyEntity } from './idempotency-key.entity';
import { IdempotencyKeyMapper } from './idempotency-key.mapper';

// MySQL's "duplicate entry for key" error (ER_DUP_ENTRY / errno 1062). A second insert
// of the same `(scope, key)` — a concurrent first-writer racing the same client key —
// surfaces this. Duck-typed (not `instanceof QueryFailedError`) because the driver may
// nest the real error under `driverError` — check both levels (the inventory
// `isDuplicateEntryError` / event-store precedent, kept local: cross-module isolation
// forbids importing the inventory util).
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

const MS_PER_HOUR = 60 * 60 * 1000;

// The single `@InjectRepository(IdempotencyKeyEntity)` site. It implements
// `IIdempotencyStorePort` DIRECTLY — deliberately NOT extending `BaseTypeormRepository`,
// whose public `save` / `softDelete` would contradict the immutable, append-only
// stored-response record (the `DomainEventTypeormRepository` precedent, ADR-035). The
// only mutating verb is `save`, which uses `insert` (never `save`-with-id semantics),
// so there is no UPDATE or DELETE expression at the persistence layer either. Returns
// domain types only — no TypeORM leak past this file (ADR-017).
@Injectable()
export class IdempotencyStoreTypeormRepository implements IIdempotencyStorePort {
  constructor(
    @InjectRepository(IdempotencyKeyEntity)
    private readonly idempotencyKeyRepository: Repository<IdempotencyKeyEntity>,
    // The retention horizon in hours, resolved from `IDEMPOTENCY_KEY_TTL_HOURS` via DI
    // (never `process.env` in this layer — ADR-017). `expires_at` is computed from it on
    // every insert.
    @Inject(IDEMPOTENCY_KEY_TTL_HOURS)
    private readonly ttlHours: number,
  ) {}

  // A read — it does NOT filter by expiry. The scheduled purge sweep is the sole
  // authority that removes expired rows, so a not-yet-swept past-`expires_at` row is
  // still returned (and served as an idempotent replay upstream). This keeps the read
  // path query-simple and all TTL logic in one place.
  public async find(scope: string, key: string): Promise<IIdempotencyRecord | null> {
    const entity = await this.idempotencyKeyRepository.findOne({ where: { scope, key } });
    return entity ? IdempotencyKeyMapper.toDomain(entity) : null;
  }

  public async save(record: IIdempotencyRecordInput, scope?: ITransactionScope): Promise<void> {
    const expiresAt = new Date(Date.now() + this.ttlHours * MS_PER_HOUR);
    const partial = IdempotencyKeyMapper.toEntity(record, expiresAt);

    // INSERT, not `save`: a stored-response row is born immutable and is never updated,
    // so there is no preload-by-id round trip. A collision on the composite PK
    // `(scope, key)` means a concurrent first-writer raced this insert in — swallow it
    // as an idempotent no-op rather than throwing, the defined outcome that lets the
    // caller fall back to `find` and serve the race-winner's stored response (the
    // event-store / `reservation` ER_DUP_ENTRY-translation precedent). Any other failure
    // propagates.
    try {
      // The cast bridges the mapper's `DeepPartial` to `insert`'s `QueryDeepPartialEntity`
      // — they coincide for scalar columns but diverge on the JSON `response_body` (which
      // `QueryDeepPartialEntity` widens to allow a SQL expression); the mapper already
      // produced a concrete, well-formed row.
      await this.idempotencyRepo(scope).insert(
        partial as QueryDeepPartialEntity<IdempotencyKeyEntity>,
      );
    } catch (error) {
      if (isDuplicateEntryError(error)) {
        return;
      }
      throw error;
    }
  }

  // Resolves the repository bound to the caller's transaction when a `scope` is supplied
  // (the `EntityManager` downcast ADR-017 §6 permits here), else the default-manager
  // repository (the `RefundTypeormRepository.refundRepo` precedent).
  private idempotencyRepo(scope?: ITransactionScope): Repository<IdempotencyKeyEntity> {
    if (!scope) {
      return this.idempotencyKeyRepository;
    }
    return (scope as unknown as EntityManager).getRepository(IdempotencyKeyEntity);
  }
}
