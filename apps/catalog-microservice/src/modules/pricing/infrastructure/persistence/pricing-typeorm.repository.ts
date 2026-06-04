import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, IsNull, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Price, TaxCategory } from '../../domain';
import { IPricingRepositoryPort } from '../../application/ports';
import { PriceEntity } from './price.entity';
import { PriceMapper } from './price.mapper';
import { TaxCategoryEntity } from './tax-category.entity';
import { TaxCategoryMapper } from './tax-category.mapper';

// The single `InjectRepository` site for the pricing context. Extends
// `BaseTypeormRepository` for the `toDomain`/`toEntity` seam; the append path is
// custom because the close-of-predecessor + insert must commit atomically
// (ADR-019 / ADR-026).
@Injectable()
export class PricingTypeormRepository
  extends BaseTypeormRepository<PriceEntity, Price>
  implements IPricingRepositoryPort
{
  constructor(
    @InjectRepository(PriceEntity)
    private readonly priceRepository: Repository<PriceEntity>,
    @InjectRepository(TaxCategoryEntity)
    private readonly taxCategoryRepository: Repository<TaxCategoryEntity>,
    @InjectPinoLogger(PricingTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {
    super(priceRepository);
  }

  protected toDomain(entity: PriceEntity): Price {
    return PriceMapper.toDomain(entity);
  }

  protected toEntity(domain: Price): DeepPartial<PriceEntity> {
    return PriceMapper.toEntity(domain);
  }

  public async findOpenPrice(variantId: number, currency: string): Promise<Price | null> {
    const entity = await this.priceRepository.findOne({
      where: { variantId, currency, validTo: IsNull() },
    });
    return entity ? PriceMapper.toDomain(entity) : null;
  }

  public async appendPrice(newPrice: Price, predecessorToClose: Price | null): Promise<Price> {
    // One transaction for the close + the insert: a window with two open rows
    // for the same `(variantId, currency)` scope would violate the
    // at-most-one-open invariant. The `UC_PRICE_OPEN_SCOPE` generated-column
    // UNIQUE index is the DB-level backstop if two appends race (ADR-026).
    const insertedId = await this.priceRepository.manager.transaction(async (manager) => {
      const priceRepo = manager.getRepository(PriceEntity);

      if (predecessorToClose !== null) {
        // The caller passes the already-closed predecessor (`open.close(at)`), so
        // its `validTo` is the concrete close timestamp. Closing is the only
        // mutation an existing price row ever receives.
        if (predecessorToClose.id === null) {
          throw new Error('PricingTypeormRepository.appendPrice: predecessorToClose has no id');
        }
        if (predecessorToClose.validTo === null) {
          throw new Error(
            'PricingTypeormRepository.appendPrice: predecessorToClose must already be closed (validTo set)',
          );
        }
        await priceRepo.update(predecessorToClose.id, { validTo: predecessorToClose.validTo });
      }

      const saved = await priceRepo.save(PriceMapper.toEntity(newPrice));
      return saved.id;
    });

    this.logger.debug(
      {
        priceId: insertedId,
        variantId: newPrice.variantId,
        currency: newPrice.currency,
        closedPredecessorId: predecessorToClose?.id ?? null,
      },
      'Price appended',
    );

    // Re-read so the returned aggregate carries the DB-assigned id and timestamps.
    // The row was just committed, so a miss here is an invariant breach.
    const reloaded = await this.priceRepository.findOne({ where: { id: insertedId } });
    if (!reloaded) {
      throw new Error(
        `PricingTypeormRepository.appendPrice: price ${insertedId} vanished after commit`,
      );
    }
    return PriceMapper.toDomain(reloaded);
  }

  public async findInEffect(variantId: number, currency: string, asOf: Date): Promise<Price[]> {
    // All rows whose `[validFrom, validTo)` interval contains `asOf`:
    // `valid_from <= asOf AND (valid_to IS NULL OR valid_to > asOf)`. The
    // ordering is a convenience for the use case (highest priority, then latest
    // validFrom); the authoritative resolution still lives there (ADR-026).
    const entities = await this.priceRepository
      .createQueryBuilder('Price')
      .where('Price.variantId = :variantId', { variantId })
      .andWhere('Price.currency = :currency', { currency })
      .andWhere('Price.validFrom <= :asOf', { asOf })
      .andWhere('(Price.validTo IS NULL OR Price.validTo > :asOf)', { asOf })
      .orderBy('Price.priority', 'DESC')
      .addOrderBy('Price.validFrom', 'DESC')
      .getMany();
    return entities.map((entity) => PriceMapper.toDomain(entity));
  }

  public async createTaxCategory(taxCategory: TaxCategory): Promise<TaxCategory> {
    const saved = await this.taxCategoryRepository.save(TaxCategoryMapper.toEntity(taxCategory));
    return TaxCategoryMapper.toDomain(saved as TaxCategoryEntity);
  }

  public async listTaxCategories(): Promise<TaxCategory[]> {
    const entities = await this.taxCategoryRepository.find({ order: { code: 'ASC' } });
    return entities.map((entity) => TaxCategoryMapper.toDomain(entity));
  }

  public async findTaxCategoryByCode(code: string): Promise<TaxCategory | null> {
    const entity = await this.taxCategoryRepository.findOne({ where: { code } });
    return entity ? TaxCategoryMapper.toDomain(entity) : null;
  }
}
