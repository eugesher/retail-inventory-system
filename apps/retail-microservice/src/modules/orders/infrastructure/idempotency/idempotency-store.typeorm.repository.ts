import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, LessThan, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import {
  IDEMPOTENCY_KEY_TTL_HOURS,
  IIdempotencyFinalizeInput,
  IIdempotencyRecord,
  IIdempotencyRecordInput,
  IIdempotencyReservation,
  IIdempotencyReserveInput,
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

// The single `@InjectRepository(IdempotencyKeyEntity)` site. It implements `IIdempotencyStorePort`
// **directly**, never through `BaseTypeormRepository`, whose public `save` / `softDelete` would let a
// caller rewrite a stored response.
//
// **A row with a response is written once and never touched again.** Everything else it does is in
// service of that:
//
//   * `save` / `reserve` **INSERT**, never `save`-with-id — so a duplicate `(scope, key)` loses on
//     the PK rather than silently overwriting the first writer's answer.
//   * `finalize` **UPDATEs** — but only a `pending` row, filling in the response it was reserved to
//     hold. It turns a claim into a record; it does not rewrite one.
//   * `release` **DELETEs** — but only a row with `responseBody IS NULL`, so a `finalize` that
//     actually committed can never be removed by a late or spurious release.
//   * `deleteExpired` **DELETEs** past-TTL rows. The store is live-ephemeral (ADR-036); this is
//     housekeeping, not a mutation of a live record.
//
// Every mutating statement is guarded by *which* row it may touch. That is what makes an
// idempotency store trustworthy: not that nothing is ever deleted, but that **a stored answer
// cannot be changed or lost while it is still the answer.**
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

  public async find(scope: string, key: string): Promise<IIdempotencyRecord | null> {
    const entity = await this.idempotencyKeyRepository.findOne({ where: { scope, key } });
    if (!entity) {
      return null;
    }
    // A pending (reserved-but-not-yet-finalized) row carries no response, so it is not a
    // replayable record — treat it as a miss for the `find`/`save` flow. In practice the
    // `find` callers (place/capture/ship) never write pending rows; this guard keeps `find`
    // robust and lets `toDomain` assume a completed row (ADR-036 reserve-first, refund).
    if (entity.responseBody === null) {
      return null;
    }
    return IdempotencyKeyMapper.toDomain(entity);
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

  // One bounded `DELETE FROM idempotency_key WHERE expires_at < ?`, served by
  // `IDX_IDEMPOTENCY_KEY_EXPIRES_AT` — it can only reach rows whose horizon has already
  // elapsed, which is what makes it safe to run against live traffic. `affected` is
  // `number | null | undefined` depending on driver, so a missing count coalesces to 0.
  public async deleteExpired(now: Date): Promise<number> {
    const result = await this.idempotencyKeyRepository.delete({ expiresAt: LessThan(now) });
    return result.affected ?? 0;
  }

  // Reserve-first (ADR-036 concurrency hardening). An atomic INSERT of a PENDING row
  // (NULL response) claims `(scope, key)` BEFORE the caller runs its side effect. The
  // outcome tells the caller what to do:
  //  - INSERT succeeds        → `reserved`: this caller owns the execution.
  //  - INSERT hits ER_DUP_ENTRY → a row already holds the key; re-read and classify it:
  //      · different fingerprint → `mismatch` (one key, two bodies → 422),
  //      · still pending (NULL response) → `in-progress` (a concurrent submit holds it → 409),
  //      · completed → `replay` (return the stored response verbatim).
  // The re-read can miss (the holder `release`d between our INSERT and the SELECT) — a
  // transient race reported as `in-progress` so the client simply retries (its next reserve
  // finds the key free). `expires_at` is computed from the injected TTL exactly as `save`.
  public async reserve(
    input: IIdempotencyReserveInput,
    scope?: ITransactionScope,
  ): Promise<IIdempotencyReservation> {
    const expiresAt = new Date(Date.now() + this.ttlHours * MS_PER_HOUR);
    const pending: QueryDeepPartialEntity<IdempotencyKeyEntity> = {
      scope: input.scope,
      key: input.key,
      requestFingerprint: input.requestFingerprint,
      responseStatus: null,
      responseBody: null,
      expiresAt,
    };

    try {
      await this.idempotencyRepo(scope).insert(pending);
      return { outcome: 'reserved' };
    } catch (error) {
      if (!isDuplicateEntryError(error)) {
        throw error;
      }
    }

    // A row already holds the composite PK — classify it. A plain SELECT never blocks on
    // the winner's row.
    const existing = await this.idempotencyKeyRepository.findOne({
      where: { scope: input.scope, key: input.key },
    });
    if (!existing) {
      // The holder released (or the purge swept) the row between our INSERT and this read
      // — report in-progress so the caller turns the client away to retry cleanly.
      return { outcome: 'in-progress' };
    }
    if (existing.requestFingerprint !== input.requestFingerprint) {
      return { outcome: 'mismatch' };
    }
    if (existing.responseBody === null) {
      return { outcome: 'in-progress' };
    }
    return { outcome: 'replay', record: IdempotencyKeyMapper.toDomain(existing) };
  }

  // Fill the response onto a row previously `reserve`d, flipping it pending → completed. A
  // targeted UPDATE keyed on the composite PK; a vanished row (a concurrent release/purge)
  // updates zero rows and is a harmless no-op (the natural idempotency backstop covers it).
  public async finalize(
    input: IIdempotencyFinalizeInput,
    scope?: ITransactionScope,
  ): Promise<void> {
    // The cast bridges the plain response fields to `update`'s `QueryDeepPartialEntity`
    // (which widens the JSON `response_body` to allow a SQL expression) — the same bridge
    // `save`/`reserve` use for `insert`.
    const completion = {
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
    } as QueryDeepPartialEntity<IdempotencyKeyEntity>;
    await this.idempotencyRepo(scope).update({ scope: input.scope, key: input.key }, completion);
  }

  // Delete the PENDING row this caller reserved, so a later retry can re-execute. Guarded
  // to `response_body IS NULL` so a `finalize` that actually committed (a completed row) is
  // NEVER removed by a spurious release — a release racing a committed finalize deletes
  // nothing and the completed row stays replayable.
  public async release(scope: string, key: string): Promise<void> {
    await this.idempotencyKeyRepository.delete({ scope, key, responseBody: IsNull() });
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
