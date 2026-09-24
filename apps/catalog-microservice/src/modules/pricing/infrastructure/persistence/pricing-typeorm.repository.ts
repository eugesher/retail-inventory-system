import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, IsNull, Repository } from 'typeorm';

import { VariantTaxHeaderView } from '@retail-inventory-system/contracts';
import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Price, TaxCategory } from '../../domain';
import { IPricingRepositoryPort } from '../../application/ports';
import { PriceEntity } from './price.entity';
import { PriceMapper } from './price.mapper';
import { TaxCategoryEntity } from './tax-category.entity';
import { TaxCategoryMapper } from './tax-category.mapper';

interface IVariantTaxHeaderRow {
  variantId: number | string;
  sku: string;
  taxCategoryId: number | string | null;
  taxCategoryCode: string | null;
}

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
    const insertedId = await this.priceRepository.manager.transaction(async (manager) => {
      const priceRepo = manager.getRepository(PriceEntity);

      if (predecessorToClose !== null) {
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

    const reloaded = await this.priceRepository.findOne({ where: { id: insertedId } });
    if (!reloaded) {
      throw new Error(
        `PricingTypeormRepository.appendPrice: price ${insertedId} vanished after commit`,
      );
    }
    return PriceMapper.toDomain(reloaded);
  }

  public async findInEffect(variantId: number, currency: string, asOf: Date): Promise<Price[]> {
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

  public async attachTaxCategoryToVariant(variantId: number, taxCategoryId: number): Promise<void> {
    await this.priceRepository.manager.query(
      'UPDATE product_variant SET tax_category_id = ? WHERE id = ?',
      [taxCategoryId, variantId],
    );
  }

  public async findVariantTaxHeader(variantId: number): Promise<VariantTaxHeaderView | null> {
    const rows = await this.priceRepository.manager.query<IVariantTaxHeaderRow[]>(
      `SELECT pv.id AS variantId,
              pv.sku AS sku,
              pv.tax_category_id AS taxCategoryId,
              tc.code AS taxCategoryCode
         FROM product_variant pv
         LEFT JOIN tax_category tc ON tc.id = pv.tax_category_id
        WHERE pv.id = ?`,
      [variantId],
    );

    if (rows.length === 0) {
      return null;
    }

    const [row] = rows;
    return {
      variantId: Number(row.variantId),
      sku: row.sku,
      taxCategoryId: row.taxCategoryId === null ? null : Number(row.taxCategoryId),
      taxCategoryCode: row.taxCategoryCode,
    };
  }
}
