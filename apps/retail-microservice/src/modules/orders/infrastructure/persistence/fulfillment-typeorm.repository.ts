import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Fulfillment } from '../../domain';
import { IFulfillmentRepositoryPort, ITransactionScope } from '../../application/ports';
import { FulfillmentEntity } from './fulfillment.entity';
import { FulfillmentLineEntity } from './fulfillment-line.entity';
import { FulfillmentLineMapper } from './fulfillment-line.mapper';
import { FulfillmentMapper } from './fulfillment.mapper';

// The single `@InjectRepository` site for the `Fulfillment` aggregate. Extends
// `BaseTypeormRepository` for the `toDomain`/`toEntity` seam; `save` is overridden
// because the root + its lines persist explicitly inside one transaction and the
// returned aggregate is re-read so the generated ids come back concrete (the "re-read
// the saved graph" idiom the order/payment repos follow). Returns domain types only —
// no TypeORM leak past this file (ADR-017).
//
// `save` / `findById` / `listByOrderId` accept an optional `ITransactionScope`: the
// later Ship operation hands the same scope to the fulfillment, order, and payment
// writes so they commit as one unit of work (ADR-017 §6 / ADR-031). The
// `EntityManager` downcast that unwraps the brand lives only in `fulfillmentRepo` /
// `scopedManager` (the place ADR-017 §6 permits it).
@Injectable()
export class FulfillmentTypeormRepository
  extends BaseTypeormRepository<FulfillmentEntity, Fulfillment>
  implements IFulfillmentRepositoryPort
{
  constructor(
    @InjectRepository(FulfillmentEntity)
    private readonly fulfillmentRepository: Repository<FulfillmentEntity>,
    @InjectRepository(FulfillmentLineEntity)
    private readonly fulfillmentLineRepository: Repository<FulfillmentLineEntity>,
  ) {
    super(fulfillmentRepository);
  }

  protected toDomain(entity: FulfillmentEntity): Fulfillment {
    return FulfillmentMapper.toDomain(entity);
  }

  protected toEntity(domain: Fulfillment): DeepPartial<FulfillmentEntity> {
    return FulfillmentMapper.toEntity(domain);
  }

  public async save(fulfillment: Fulfillment, scope?: ITransactionScope): Promise<Fulfillment> {
    // One transaction for the root + its lines: a half-written graph (the header
    // committed but a line missing) would misreport which quantities shipped. When the
    // caller already owns a transaction (`scope`), join it — Ship commits the
    // fulfillment, order, and payment atomically — else open one.
    let id: number;
    if (scope) {
      id = await this.persistGraph(scope as unknown as EntityManager, fulfillment);
    } else {
      id = await this.fulfillmentRepository.manager.transaction((manager) =>
        this.persistGraph(manager, fulfillment),
      );
    }

    // Re-read the full graph (within the same scope when transactional) so the
    // returned aggregate carries the concrete generated `fulfillment_line.id`s, the
    // committed version, and the DB timestamps. The row was just written, so a miss is
    // an invariant breach.
    const reloaded = await this.findById(id, scope);
    if (!reloaded) {
      throw new Error(`FulfillmentTypeormRepository.save: fulfillment ${id} vanished after commit`);
    }
    return reloaded;
  }

  public async findById(id: number, scope?: ITransactionScope): Promise<Fulfillment | null> {
    const entity = await this.fulfillmentRepo(scope).findOne({
      where: { id },
      relations: { lines: true },
      // Deterministic line order so the view is stable across reads.
      order: { lines: { id: 'ASC' } },
    });
    return entity ? FulfillmentMapper.toDomain(entity) : null;
  }

  // The by-id load path under a pessimistic write lock (`SELECT … FOR UPDATE`). Unlike
  // the non-locking `findById` — which, under InnoDB REPEATABLE READ, serves the
  // transaction's snapshot and so cannot observe a concurrent committed transition —
  // this is a CURRENT read: it reads the latest committed row and holds an exclusive
  // lock on it until the transaction commits. Ship and Cancel both re-read the contended
  // fulfillment with it inside their transaction, so a concurrent ship-vs-cancel
  // serialises on the row lock: the loser blocks until the winner commits, then observes
  // the committed status and its status precondition rejects it (the
  // single-writer-per-status-transition guard, ADR-031). A `QueryBuilder` with an
  // explicit `setLock` carries `FOR UPDATE` through the `lines` left join (MySQL locks
  // the matched rows of every joined table); the lock requires an active transaction,
  // hence the mandatory `scope`.
  public async findByIdForUpdate(
    id: number,
    scope: ITransactionScope,
  ): Promise<Fulfillment | null> {
    const entity = await this.fulfillmentRepo(scope)
      .createQueryBuilder('fulfillment')
      .setLock('pessimistic_write')
      .leftJoinAndSelect('fulfillment.lines', 'lines')
      .where('fulfillment.id = :id', { id })
      .getOne();
    return entity ? FulfillmentMapper.toDomain(entity) : null;
  }

  // An order's fulfillments, newest-first by `shipped_at` then `id` (the
  // `(order_id, shipped_at)` index supports it; a still-`pending` fulfillment has a
  // null `shipped_at`, which sorts last under `DESC`). Backs the order's fulfillment
  // roll-up + the cross-fulfillment sum / Cancel-Order preconditions.
  public async listByOrderId(orderId: number, scope?: ITransactionScope): Promise<Fulfillment[]> {
    const entities = await this.fulfillmentRepo(scope).find({
      where: { orderId },
      relations: { lines: true },
      order: { shippedAt: 'DESC', id: 'DESC', lines: { id: 'ASC' } },
    });
    return entities.map((entity) => FulfillmentMapper.toDomain(entity));
  }

  // Persists the root + its lines on the given manager and returns the fulfillment id.
  // On a NEW fulfillment (`id===null`) the root insert assigns the BIGINT id, then the
  // lines are inserted owning it. On a re-save (a ship/deliver/cancel status + version
  // bump) the lines are immutable (no mutator touches them), so update the root only —
  // rewriting N unchanged line rows would be pure waste (the `OrderTypeormRepository`
  // precedent).
  private async persistGraph(manager: EntityManager, fulfillment: Fulfillment): Promise<number> {
    const fulfillmentRepo = manager.getRepository(FulfillmentEntity);
    const lineRepo = manager.getRepository(FulfillmentLineEntity);

    if (fulfillment.id === null) {
      const inserted = await fulfillmentRepo.save(FulfillmentMapper.toEntity(fulfillment));
      const newId = Number(inserted.id);
      await this.persistLines(lineRepo, fulfillment, newId);
      return newId;
    }

    const existingId = fulfillment.id;
    await fulfillmentRepo.save({ ...FulfillmentMapper.toEntity(fulfillment), id: existingId });
    return existingId;
  }

  private async persistLines(
    lineRepo: Repository<FulfillmentLineEntity>,
    fulfillment: Fulfillment,
    fulfillmentId: number,
  ): Promise<void> {
    const lineEntities = fulfillment.lines.map((line) =>
      FulfillmentLineMapper.toEntity(line, fulfillmentId),
    );
    if (lineEntities.length > 0) {
      await lineRepo.save(lineEntities);
    }
  }

  // Resolves the fulfillment repository bound to the caller's transaction when a
  // `scope` is supplied (downcast back to the `EntityManager` the adapter brand-wraps
  // — the one place that downcast is allowed, ADR-017 §6), else the default-manager
  // repository.
  private fulfillmentRepo(scope?: ITransactionScope): Repository<FulfillmentEntity> {
    if (!scope) {
      return this.fulfillmentRepository;
    }
    return (scope as unknown as EntityManager).getRepository(FulfillmentEntity);
  }
}
