import { EntityManager, Repository } from 'typeorm';

import { ReturnRequest } from '../../domain';
import { IReturnRequestWriteRepositoryPort } from '../../application/ports';
import { ReturnWriteConflictError } from '../../application/use-cases/return-write-conflict.error';
import { ReturnLineEntity } from './return-line.entity';
import { ReturnLineMapper } from './return-line.mapper';
import { ReturnRequestEntity } from './return-request.entity';
import { ReturnRequestMapper } from './return-request.mapper';

// The write-capable `ReturnRequest` repository (ADR-063) — bound to ONE transaction's
// `EntityManager`, constructed fresh per `ReturnsUnitOfWorkAdapter.run()` call. It is never
// registered with Nest's DI container and carries no `@Injectable()` / `@InjectRepository`
// — the only way to obtain an instance is through `IReturnsUnitOfWork.returnRequests`
// inside a unit of work, which is the type-level guarantee this ADR is for.
//
// Carries `persistGraph` / `persistRoot` / `persistLines` verbatim from the pre-UoW
// `ReturnRequestTypeormRepository.save` — the root+lines-in-one-transaction idiom, the
// provisional-then-finalized `rma_number`, and the version-checked CAS are unchanged; only
// the "join a caller's scope, or open my own" branch is gone, because there is no longer an
// unscoped path through this class at all.
export class ReturnRequestWriteTypeormRepository implements IReturnRequestWriteRepositoryPort {
  constructor(
    // The transaction's own manager — every write in `save` runs on this.
    private readonly manager: EntityManager,
    // The DEFAULT-connection manager, used for exactly one thing: re-reading a lost CAS's
    // now-current version on a FRESH snapshot after a conflict (see `save`'s catch below).
    // Reading it through `this.manager` would still be inside the still-open transaction
    // that lost the race, whose REPEATABLE READ snapshot predates the concurrent winner's
    // commit — it would not see the row the caller needs to refetch-and-retry against.
    private readonly defaultManager: EntityManager,
  ) {}

  public async findById(id: number): Promise<ReturnRequest | null> {
    const entity = await this.manager.getRepository(ReturnRequestEntity).findOne({
      where: { id },
      relations: { lines: true },
      order: { lines: { id: 'ASC' } },
    });
    return entity ? ReturnRequestMapper.toDomain(entity) : null;
  }

  public async save(
    returnRequest: ReturnRequest,
    expectedVersion?: number,
  ): Promise<ReturnRequest> {
    let id: number;
    try {
      id = await this.persistGraph(returnRequest, expectedVersion);
    } catch (error) {
      if (error instanceof ReturnWriteConflictError) {
        // See the constructor note: a fresh, uncontended read on the default connection,
        // not this write's own (about-to-roll-back) transaction.
        const current = await this.defaultManager
          .getRepository(ReturnRequestEntity)
          .findOne({ where: { id: error.rmaId } });
        throw new ReturnWriteConflictError(
          error.rmaId,
          current ? Number(current.version) : expectedVersion!,
        );
      }
      throw error;
    }

    // Re-read within the SAME transaction so the returned aggregate carries the concrete
    // generated `return_line.id`s, the finalized `rma_number`, the committed version, and
    // the DB timestamps. The row was just written, so a miss is an invariant breach.
    const reloaded = await this.findById(id);
    if (!reloaded) {
      throw new Error(
        `ReturnRequestWriteTypeormRepository.save: return request ${id} vanished after commit`,
      );
    }
    return reloaded;
  }

  // Persists the root + its lines on this repository's transactional manager and returns
  // the request id. On a NEW request (`id===null`) the root is inserted with a NULL
  // `rma_number` (MySQL allows multiple NULLs under a UNIQUE index, so no provisional token
  // is needed — unlike the NOT-NULL `order_number`), then the generated id finalizes the
  // real RMA number in a targeted UPDATE, then the lines are inserted owning the id. On a
  // re-save (an authorize/reject/receive/inspect/close status + version bump, plus the
  // inspection columns Inspect sets) `rma_number` is immutable, so it is stripped before the
  // root update; the lines are re-persisted because a line's inspection columns advance.
  private async persistGraph(
    returnRequest: ReturnRequest,
    expectedVersion: number | undefined,
  ): Promise<number> {
    const requestRepo = this.manager.getRepository(ReturnRequestEntity);
    const lineRepo = this.manager.getRepository(ReturnLineEntity);

    if (returnRequest.id === null) {
      const inserted = await requestRepo.save(ReturnRequestMapper.toEntity(returnRequest));
      const newId = Number(inserted.id);

      const year = returnRequest.requestedAt.getUTCFullYear();
      const rmaNumber = ReturnRequestWriteTypeormRepository.formatRmaNumber(year, newId);
      await requestRepo.update({ id: newId }, { rmaNumber });

      await this.persistLines(lineRepo, returnRequest, newId);
      return newId;
    }

    const existingId = returnRequest.id;
    await this.persistRoot(requestRepo, returnRequest, existingId, expectedVersion);

    // This runs only after the root CAS succeeded, so a losing attempt writes no lines.
    await this.persistLines(lineRepo, returnRequest, existingId);
    return existingId;
  }

  // Persists the return-request root on a re-save. When `expectedVersion` is supplied it is
  // an optimistic compare-and-swap on the root `version` (ADR-036): every status transition
  // bumps it via `version = version + 1`, and the `WHERE id = ? AND version = expectedVersion`
  // predicate makes a concurrent writer (who already bumped it) match zero rows — a
  // retryable `ReturnWriteConflictError` rather than a silent lost update. When
  // `expectedVersion` is absent the write is the plain managed save (TypeORM still advances
  // `@VersionColumn`). `rma_number` is immutable, so it is never written on a re-save.
  private async persistRoot(
    requestRepo: Repository<ReturnRequestEntity>,
    returnRequest: ReturnRequest,
    existingId: number,
    expectedVersion: number | undefined,
  ): Promise<void> {
    if (expectedVersion === undefined) {
      const rootPartial = ReturnRequestMapper.toEntity(returnRequest);
      delete rootPartial.rmaNumber;
      await requestRepo.save({ ...rootPartial, id: existingId });
      return;
    }

    const result = await requestRepo.update(
      { id: existingId, version: expectedVersion },
      {
        orderId: returnRequest.orderId,
        customerId: returnRequest.customerId,
        status: returnRequest.status,
        reasonCategory: returnRequest.reasonCategory,
        notes: returnRequest.notes,
        requestedAt: returnRequest.requestedAt,
        authorizedAt: returnRequest.authorizedAt,
        closedAt: returnRequest.closedAt,
        version: (): string => 'version + 1',
      },
    );

    if (!result.affected) {
      // Signal a lost race; the outer `save` re-reads the committed version and rethrows a
      // conflict carrying it (on the default connection, not this transaction).
      throw new ReturnWriteConflictError(existingId, expectedVersion);
    }
  }

  private async persistLines(
    lineRepo: Repository<ReturnLineEntity>,
    returnRequest: ReturnRequest,
    returnRequestId: number,
  ): Promise<void> {
    const lineEntities = returnRequest.lines.map((line) =>
      ReturnLineMapper.toEntity(line, returnRequestId),
    );
    if (lineEntities.length > 0) {
      await lineRepo.save(lineEntities);
    }
  }

  private static formatRmaNumber(year: number, id: number): string {
    return `RMA-${year}-${String(id).padStart(8, '0')}`;
  }
}
