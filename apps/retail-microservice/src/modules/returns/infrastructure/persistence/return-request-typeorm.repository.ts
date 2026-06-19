import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { ReturnRequest } from '../../domain';
import { IReturnRequestRepositoryPort, ITransactionScope } from '../../application/ports';
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
  ): Promise<ReturnRequest> {
    // One transaction for the root + its lines: a half-written graph (the header
    // committed but a line missing) would misreport which quantities are coming back.
    // When the caller already owns a transaction (`scope`), join it — Inspect/Close
    // commit the RMA, the refund, and the payment atomically — else open one.
    let id: number;
    if (scope) {
      id = await this.persistGraph(scope as unknown as EntityManager, returnRequest);
    } else {
      id = await this.returnRequestRepository.manager.transaction((manager) =>
        this.persistGraph(manager, returnRequest),
      );
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
    const rootPartial = ReturnRequestMapper.toEntity(returnRequest);
    delete rootPartial.rmaNumber;
    await requestRepo.save({ ...rootPartial, id: existingId });

    await this.persistLines(lineRepo, returnRequest, existingId);
    return existingId;
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
