import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { ReturnRequest } from '../../domain';
import { IReturnRequestRepositoryPort, ITransactionScope } from '../../application/ports';
import { ReturnWriteConflictError } from '../../application/use-cases/return-write-conflict.error';
import { ReturnRequestEntity } from './return-request.entity';
import { ReturnLineEntity } from './return-line.entity';
import { ReturnLineMapper } from './return-line.mapper';
import { ReturnRequestMapper } from './return-request.mapper';

// The single `@InjectRepository` site for the `ReturnRequest` aggregate. Extends
// `BaseTypeormRepository` for the `toDomain`/`toEntity` seam; `save` is overridden
// because the root + its lines persist explicitly inside one transaction and the
// human-facing `rma_number` is finalized from the generated id (the "re-read the saved
// graph, then finalize a derived field" idiom the order repo follows). Returns domain
// types only — no TypeORM leak past this file (ADR-017).
//
// `save` / `findById` accept an optional `ITransactionScope`: the later Inspect/Close
// operations hand the same scope to the return-request, refund, and payment writes so
// they commit as one unit of work (ADR-017 §6 / ADR-032). The `EntityManager` downcast
// that unwraps the brand lives only in `returnRequestRepo` (the place ADR-017 §6
// permits it).
@Injectable()
export class ReturnRequestTypeormRepository
  extends BaseTypeormRepository<ReturnRequestEntity, ReturnRequest>
  implements IReturnRequestRepositoryPort
{
  constructor(
    @InjectRepository(ReturnRequestEntity)
    private readonly returnRequestRepository: Repository<ReturnRequestEntity>,
    @InjectRepository(ReturnLineEntity)
    private readonly returnLineRepository: Repository<ReturnLineEntity>,
  ) {
    super(returnRequestRepository);
  }

  protected toDomain(entity: ReturnRequestEntity): ReturnRequest {
    return ReturnRequestMapper.toDomain(entity);
  }

  protected toEntity(domain: ReturnRequest): DeepPartial<ReturnRequestEntity> {
    return ReturnRequestMapper.toEntity(domain);
  }

  public async save(
    returnRequest: ReturnRequest,
    scope?: ITransactionScope,
    expectedVersion?: number,
  ): Promise<ReturnRequest> {
    // One transaction for the root + its lines: a half-written graph (the header
    // committed but a line missing) would misreport which quantities are coming back.
    // When the caller already owns a transaction (`scope`), join it — Inspect commits
    // the RMA + the inspection columns atomically — else open one. When `expectedVersion`
    // is supplied (a status transition on an existing RMA) the root write is an
    // optimistic compare-and-swap on `version` (ADR-036); otherwise it is a plain insert
    // (the Open path, no live row to race).
    let id: number;
    try {
      if (scope) {
        id = await this.persistGraph(
          scope as unknown as EntityManager,
          returnRequest,
          expectedVersion,
        );
      } else {
        id = await this.returnRequestRepository.manager.transaction((manager) =>
          this.persistGraph(manager, returnRequest, expectedVersion),
        );
      }
    } catch (error) {
      if (error instanceof ReturnWriteConflictError) {
        // The transaction rolled back on the lost CAS. Read the row's now-current
        // version on a fresh query (the default manager, NOT the rolled-back scope's
        // snapshot — a plain SELECT never blocks on the zero-row UPDATE's row lock) so
        // the conflict signal carries the accurate committed version.
        const current = await this.returnRequestRepository.findOne({ where: { id: error.rmaId } });
        throw new ReturnWriteConflictError(
          error.rmaId,
          current ? Number(current.version) : expectedVersion!,
        );
      }
      throw error;
    }

    // Re-read the full graph (within the same scope when transactional) so the returned
    // aggregate carries the concrete generated `return_line.id`s, the finalized
    // `rma_number`, the committed version, and the DB timestamps. The row was just
    // written, so a miss is an invariant breach.
    const reloaded = await this.findById(id, scope);
    if (!reloaded) {
      throw new Error(
        `ReturnRequestTypeormRepository.save: return request ${id} vanished after commit`,
      );
    }
    return reloaded;
  }

  public async findById(id: number, scope?: ITransactionScope): Promise<ReturnRequest | null> {
    const entity = await this.returnRequestRepo(scope).findOne({
      where: { id },
      relations: { lines: true },
      // Deterministic line order so the view is stable across reads.
      order: { lines: { id: 'ASC' } },
    });
    return entity ? ReturnRequestMapper.toDomain(entity) : null;
  }

  // An order's return requests, newest-first by `requested_at` then `id` (the
  // `(order_id, requested_at)` index supports it). Backs both the list read and the
  // Open use case's already-returned-quantity sum.
  public async listByOrderId(orderId: number): Promise<ReturnRequest[]> {
    const entities = await this.returnRequestRepository.find({
      where: { orderId },
      relations: { lines: true },
      order: { requestedAt: 'DESC', id: 'DESC', lines: { id: 'ASC' } },
    });
    return entities.map((entity) => ReturnRequestMapper.toDomain(entity));
  }

  // Persists the root + its lines on the given manager and returns the request id. On a
  // NEW request (`id===null`) the root is inserted with a NULL `rma_number` (MySQL
  // allows multiple NULLs under a UNIQUE index, so no provisional token is needed —
  // unlike the NOT-NULL `order_number`), then the generated id finalizes the real RMA
  // number in a targeted UPDATE, then the lines are inserted owning the id. On a re-save
  // (an authorize/reject/receive/inspect/close status + version bump, plus the
  // inspection columns the Inspect use case sets) `rma_number` is immutable, so it is
  // stripped before the root update; the lines are re-persisted because a line's
  // inspection columns advance (the `OrderTypeormRepository` line-status precedent).
  private async persistGraph(
    manager: EntityManager,
    returnRequest: ReturnRequest,
    expectedVersion: number | undefined,
  ): Promise<number> {
    const requestRepo = manager.getRepository(ReturnRequestEntity);
    const lineRepo = manager.getRepository(ReturnLineEntity);

    if (returnRequest.id === null) {
      const inserted = await requestRepo.save(ReturnRequestMapper.toEntity(returnRequest));
      const newId = Number(inserted.id);

      const year = returnRequest.requestedAt.getUTCFullYear();
      const rmaNumber = ReturnRequestTypeormRepository.formatRmaNumber(year, newId);
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

  // Persists the return-request root on a re-save. When `expectedVersion` is supplied it
  // is an optimistic compare-and-swap on the root `version` (ADR-036): every status
  // transition bumps it via `version = version + 1`, and the
  // `WHERE id = ? AND version = expectedVersion` predicate makes a concurrent writer
  // (who already bumped it) match zero rows — a retryable `ReturnWriteConflictError`
  // rather than a silent lost update. When `expectedVersion` is absent the write is the
  // plain managed save (TypeORM still advances `@VersionColumn`). `rma_number` is
  // immutable, so it is never written on a re-save.
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
      // Signal a lost race; the outer `save` re-reads the committed version and rethrows
      // a conflict carrying it (kept out of this snapshot-bound tx).
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

  // Resolves the return-request repository bound to the caller's transaction when a
  // `scope` is supplied (downcast back to the `EntityManager` the adapter brand-wraps —
  // the one place that downcast is allowed, ADR-017 §6), else the default-manager
  // repository.
  private returnRequestRepo(scope?: ITransactionScope): Repository<ReturnRequestEntity> {
    if (!scope) {
      return this.returnRequestRepository;
    }
    return (scope as unknown as EntityManager).getRepository(ReturnRequestEntity);
  }

  private static formatRmaNumber(year: number, id: number): string {
    return `RMA-${year}-${String(id).padStart(8, '0')}`;
  }
}
