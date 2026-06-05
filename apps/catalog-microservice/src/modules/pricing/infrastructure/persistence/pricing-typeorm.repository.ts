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

// The raw-query row shape for `findVariantTaxHeader`. mysql2 may surface numeric
// columns as strings, so the numerics are typed loosely here and coerced in the
// method. Typing the `manager.query<...>` generic with this row avoids both an
// `any` leak (no `as` cast) and a `no-unsafe-assignment` on the result.
interface IVariantTaxHeaderRow {
  variantId: number | string;
  sku: string;
  taxCategoryId: number | string | null;
  taxCategoryCode: string | null;
}

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

  public async attachTaxCategoryToVariant(variantId: number, taxCategoryId: number): Promise<void> {
    // `tax_category_id` is a pricing-introduced column on the catalog-owned
    // `product_variant` table. Pricing writes it with a PARAMETERIZED query
    // through its injected `EntityManager` rather than importing the catalog
    // `ProductVariantEntity` — that cross-module infrastructure import is the
    // boundaries lint's red line (ADR-017 / ADR-026 §5). The FK + the opaque
    // `variantId` are the only coupling. The `?` placeholders are bound by the
    // driver, so `variantId` / `taxCategoryId` are never string-concatenated in.
    await this.priceRepository.manager.query(
      'UPDATE product_variant SET tax_category_id = ? WHERE id = ?',
      [taxCategoryId, variantId],
    );
  }

  public async findVariantTaxHeader(variantId: number): Promise<VariantTaxHeaderView | null> {
    // Same parameterized-query boundary: read only the columns the tax header
    // needs, joining `tax_category` LEFT so an unclassified variant returns NULL
    // category columns rather than dropping the row. A missing variant yields an
    // empty result set → `null` (the attach use case maps that to
    // `VARIANT_NOT_FOUND`). Typing the `query<...>` generic keeps the result off
    // `any` without an assertion (ADR-017's no-unsafe-* rules).
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
      // Coerce the numeric columns defensively — the driver may surface them as
      // strings; `null` must survive (an unclassified variant), so guard before
      // `Number(...)` (`Number(null)` is `0`, which would be wrong).
      variantId: Number(row.variantId),
      sku: row.sku,
      taxCategoryId: row.taxCategoryId === null ? null : Number(row.taxCategoryId),
      taxCategoryCode: row.taxCategoryCode,
    };
  }
}
