import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { entityManagerOf } from '@retail-inventory-system/database';

import {
  IStockMovementListQuery,
  IStockMovementPage,
  IStockMovementRepositoryPort,
  ITransactionScope,
} from '../../application/ports';
import { StockMovement } from '../../domain';
import { StockMovementEntity } from './stock-movement.entity';
import { StockMovementMapper } from './stock-movement.mapper';

@Injectable()
export class StockMovementTypeormRepository implements IStockMovementRepositoryPort {
  constructor(
    @InjectRepository(StockMovementEntity)
    private readonly stockMovementRepository: Repository<StockMovementEntity>,
  ) {}

  public async append(movement: StockMovement, scope?: ITransactionScope): Promise<StockMovement> {
    const repo = this.repo(scope);
    const partial = StockMovementMapper.toEntity(movement);

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
    if (query.from !== undefined && query.to !== undefined) {
      where.occurredAt = Between(query.from, query.to);
    } else if (query.from !== undefined) {
      where.occurredAt = MoreThanOrEqual(query.from);
    } else if (query.to !== undefined) {
      where.occurredAt = LessThanOrEqual(query.to);
    }

    const [entities, total] = await this.stockMovementRepository.findAndCount({
      where,
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
    return this.repo(scope).exist({ where: { referenceType, referenceId } });
  }

  private repo(scope?: ITransactionScope): Repository<StockMovementEntity> {
    if (!scope) {
      return this.stockMovementRepository;
    }
    const manager = entityManagerOf(scope);
    return manager.getRepository(StockMovementEntity);
  }
}
