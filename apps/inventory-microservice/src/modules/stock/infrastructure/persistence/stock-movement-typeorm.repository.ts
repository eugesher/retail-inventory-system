import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  EntityManager,
  FindOptionsWhere,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import {
  IStockMovementListQuery,
  IStockMovementPage,
  IStockMovementRepositoryPort,
  ITransactionScope,
} from '../../application/ports';
import { StockMovement } from '../../domain';
import { StockMovementEntity } from './stock-movement.entity';
import { StockMovementMapper } from './stock-movement.mapper';

// The single `@InjectRepository(StockMovementEntity)` site. It implements
// `IStockMovementRepositoryPort` DIRECTLY — deliberately NOT extending
// `BaseTypeormRepository`, whose public `save` / `softDelete` would contradict the
// append-only ledger (ADR-030 §2). The only mutating verb here is `append`, which
// uses `insert` (never `save`-with-id semantics), so an UPDATE or DELETE has no
// expression at the persistence layer either. Returns domain types only — no
// TypeORM leak past this file (ADR-017).
@Injectable()
export class StockMovementTypeormRepository implements IStockMovementRepositoryPort {
  constructor(
    @InjectRepository(StockMovementEntity)
    private readonly stockMovementRepository: Repository<StockMovementEntity>,
  ) {}

  public async append(movement: StockMovement, scope?: ITransactionScope): Promise<StockMovement> {
    const repo = this.repo(scope);
    const partial = StockMovementMapper.toEntity(movement);

    // INSERT, not `save`: a movement is born with a null id and is never updated,
    // so there is no preload-by-id round trip. `insert` returns the DB-assigned
    // BIGINT in `identifiers`; re-read by it so the returned aggregate carries the
    // concrete `id` + the stored `occurred_at`.
    const result = await repo.insert(partial);
    const generatedId = result.identifiers[0]?.id as number | undefined;
    if (generatedId === undefined) {
      throw new Error('StockMovementTypeormRepository.append: INSERT returned no id');
    }

    const reloaded = await repo.findOne({ where: { id: generatedId } });
    if (!reloaded) {
      throw new Error(
        `StockMovementTypeormRepository.append: movement ${generatedId} vanished after insert`,
      );
    }
    return StockMovementMapper.toDomain(reloaded);
  }

  public async listByVariant(query: IStockMovementListQuery): Promise<IStockMovementPage> {
    const where: FindOptionsWhere<StockMovementEntity> = { variantId: query.variantId };
    if (query.type !== undefined) {
      where.type = query.type;
    }
    // Inclusive `occurred_at` window: both bounds → BETWEEN, one bound → a single
    // half-open comparison.
    if (query.from !== undefined && query.to !== undefined) {
      where.occurredAt = Between(query.from, query.to);
    } else if (query.from !== undefined) {
      where.occurredAt = MoreThanOrEqual(query.from);
    } else if (query.to !== undefined) {
      where.occurredAt = LessThanOrEqual(query.to);
    }

    const [entities, total] = await this.stockMovementRepository.findAndCount({
      where,
      // Newest-first; the `id DESC` tiebreaker makes the order total when two rows
      // share an `occurred_at` (the `IDX_STOCK_MOVEMENT_VARIANT_OCCURRED` index
      // serves the leading `variant_id, occurred_at DESC` scan).
      order: { occurredAt: 'DESC', id: 'DESC' },
      skip: (query.page - 1) * query.size,
      take: query.size,
    });

    return {
      items: entities.map((entity) => StockMovementMapper.toDomain(entity)),
      total,
    };
  }

  public async existsByReference(
    referenceType: string,
    referenceId: string,
    scope?: ITransactionScope,
  ): Promise<boolean> {
    // `SELECT 1 … WHERE reference_type = ? AND reference_id = ? LIMIT 1` — TypeORM's
    // `exist` compiles to exactly that, served by the
    // `IDX_STOCK_MOVEMENT_REFERENCE (reference_type, reference_id)` index. A read, so
    // the append-only invariant is untouched.
    return this.repo(scope).exist({ where: { referenceType, referenceId } });
  }

  // Resolves the repository bound to the caller's transaction when a `scope` is
  // supplied (downcast back to the `EntityManager` the adapter brand-wraps — the
  // one place that downcast is allowed, ADR-017 §6), else the default-manager
  // repository.
  private repo(scope?: ITransactionScope): Repository<StockMovementEntity> {
    if (!scope) {
      return this.stockMovementRepository;
    }
    const manager = scope as unknown as EntityManager;
    return manager.getRepository(StockMovementEntity);
  }
}
