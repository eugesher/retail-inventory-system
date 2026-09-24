import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, FindOptionsWhere, In, Repository } from 'typeorm';

import { BaseTypeormRepository, entityManagerOf } from '@retail-inventory-system/database';

import { StockLevel, StockLocation } from '../../domain';
import { IStockRepositoryPort, ITransactionScope } from '../../application/ports';
import { isDuplicateEntryError } from '../../application/use-cases/mysql-error.util';
import { StockWriteConflictError } from '../../application/use-cases/stock-write-conflict.error';
import { StockLevelEntity } from './stock-level.entity';
import { StockLevelMapper } from './stock-level.mapper';
import { StockLocationEntity } from './stock-location.entity';
import { StockLocationMapper } from './stock-location.mapper';

@Injectable()
export class StockTypeormRepository
  extends BaseTypeormRepository<StockLevelEntity, StockLevel>
  implements IStockRepositoryPort
{
  constructor(
    @InjectRepository(StockLevelEntity)
    private readonly stockLevelRepository: Repository<StockLevelEntity>,
    @InjectRepository(StockLocationEntity)
    private readonly stockLocationRepository: Repository<StockLocationEntity>,
    @InjectPinoLogger(StockTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {
    super(stockLevelRepository);
  }

  protected toDomain(entity: StockLevelEntity): StockLevel {
    return StockLevelMapper.toDomain(entity);
  }

  protected toEntity(domain: StockLevel): DeepPartial<StockLevelEntity> {
    return StockLevelMapper.toEntity(domain);
  }

  public async findLocation(id: string): Promise<StockLocation | null> {
    const entity = await this.stockLocationRepository.findOne({ where: { id } });
    return entity ? StockLocationMapper.toDomain(entity) : null;
  }

  public async listLocations(activeOnly = false): Promise<StockLocation[]> {
    const where: FindOptionsWhere<StockLocationEntity> = activeOnly ? { active: true } : {};
    const entities = await this.stockLocationRepository.find({ where, order: { id: 'ASC' } });
    return entities.map((entity) => StockLocationMapper.toDomain(entity));
  }

  public async findStockLevel(
    variantId: number,
    stockLocationId: string,
    scope?: ITransactionScope,
  ): Promise<StockLevel | null> {
    const entity = await this.levelRepo(scope).findOne({
      where: { variantId, stockLocationId },
    });
    return entity ? StockLevelMapper.toDomain(entity) : null;
  }

  public async findStockLevelsByVariant(
    variantId: number,
    stockLocationIds?: string[],
  ): Promise<StockLevel[]> {
    const where: FindOptionsWhere<StockLevelEntity> =
      stockLocationIds && stockLocationIds.length > 0
        ? { variantId, stockLocationId: In(stockLocationIds) }
        : { variantId };
    const entities = await this.stockLevelRepository.find({ where });
    return entities.map((entity) => StockLevelMapper.toDomain(entity));
  }

  public async saveStockLevel(stockLevel: StockLevel): Promise<StockLevel> {
    const partial = StockLevelMapper.toEntity(stockLevel);

    if (partial.id === undefined) {
      const existing = await this.stockLevelRepository.findOne({
        where: { variantId: stockLevel.variantId, stockLocationId: stockLevel.stockLocationId },
      });
      if (existing) {
        partial.id = existing.id;
      }
    }

    const saved = await this.stockLevelRepository.save(partial);

    this.logger.debug(
      { stockLevelId: saved.id, variantId: stockLevel.variantId },
      'Stock level persisted',
    );

    return this.reload(this.stockLevelRepository, saved.id);
  }

  public async persistStockLevelChange(
    stockLevel: StockLevel,
    expectedVersion: number | null,
    scope?: ITransactionScope,
  ): Promise<StockLevel> {
    const repo = this.levelRepo(scope);

    if (expectedVersion === null) {
      const partial = StockLevelMapper.toEntity(stockLevel);
      let savedId: number;
      try {
        const saved = await repo.save(partial);
        savedId = saved.id;
      } catch (error) {
        if (isDuplicateEntryError(error)) {
          throw new StockWriteConflictError(stockLevel.variantId, stockLevel.stockLocationId);
        }
        throw error;
      }
      return this.reload(repo, savedId);
    }

    const result = await repo.update(
      { id: stockLevel.id!, version: expectedVersion },
      {
        quantityOnHand: stockLevel.quantityOnHand,
        quantityAllocated: stockLevel.quantityAllocated,
        quantityReserved: stockLevel.quantityReserved,
        version: () => 'version + 1',
      },
    );

    if (!result.affected) {
      throw new StockWriteConflictError(
        stockLevel.variantId,
        stockLevel.stockLocationId,
        expectedVersion,
      );
    }

    return this.reload(repo, stockLevel.id!);
  }

  private levelRepo(scope?: ITransactionScope): Repository<StockLevelEntity> {
    if (!scope) {
      return this.stockLevelRepository;
    }
    const manager = entityManagerOf(scope);
    return manager.getRepository(StockLevelEntity);
  }

  private async reload(repo: Repository<StockLevelEntity>, id: number): Promise<StockLevel> {
    const reloaded = await repo.findOne({ where: { id } });
    if (!reloaded) {
      throw new Error(`StockTypeormRepository: stock_level ${id} vanished after commit`);
    }
    return StockLevelMapper.toDomain(reloaded);
  }
}
