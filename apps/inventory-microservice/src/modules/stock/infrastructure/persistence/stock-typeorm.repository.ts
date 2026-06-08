import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, FindOptionsWhere, In, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { StockLevel, StockLocation } from '../../domain';
import { IStockRepositoryPort } from '../../application/ports';
import { StockLevelEntity } from './stock-level.entity';
import { StockLevelMapper } from './stock-level.mapper';
import { StockLocationEntity } from './stock-location.entity';
import { StockLocationMapper } from './stock-location.mapper';

// The only `@InjectRepository` site for the inventory context. Extends
// `BaseTypeormRepository` for the `toDomain`/`toEntity` seam over the primary
// `StockLevel` aggregate; `StockLocation` is the secondary read model (its own
// repository, like `TaxCategory` in pricing). Returns domain types only — no
// TypeORM leak past this file (ADR-017).
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
  ): Promise<StockLevel | null> {
    const entity = await this.stockLevelRepository.findOne({
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

    // A detached level (id null) for an existing `(variant_id, stock_location_id)`
    // pair must UPDATE that row, not collide with the UNIQUE constraint on
    // INSERT — resolve to the live id first so `save` takes the update path.
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

    // Re-read so the returned aggregate carries the concrete generated id, the
    // TypeORM-managed version, and the DB timestamps. The row was just
    // committed, so a miss here is an invariant breach rather than a not-found.
    const reloaded = await this.stockLevelRepository.findOne({ where: { id: saved.id } });
    if (!reloaded) {
      throw new Error(
        `StockTypeormRepository.saveStockLevel: stock_level ${saved.id} vanished after commit`,
      );
    }
    return StockLevelMapper.toDomain(reloaded);
  }
}
