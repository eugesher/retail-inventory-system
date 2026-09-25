import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IActivePriceProbePort } from '../../application/ports';
import { ProductVariantEntity } from './product-variant.entity';

interface IPricedVariantRow {
  variantId: number | string;
}

@Injectable()
export class ActivePriceProbeTypeormAdapter implements IActivePriceProbePort {
  constructor(
    @InjectRepository(ProductVariantEntity)
    private readonly variantRepository: Repository<ProductVariantEntity>,
  ) {}

  public async findVariantsMissingActivePrice(
    variantIds: number[],
    currency: string,
  ): Promise<number[]> {
    if (variantIds.length === 0) {
      return [];
    }

    const placeholders = variantIds.map(() => '?').join(', ');
    const rows = await this.variantRepository.manager.query<IPricedVariantRow[]>(
      `SELECT DISTINCT variant_id AS variantId
         FROM price
        WHERE variant_id IN (${placeholders})
          AND currency = ?
          AND valid_from <= UTC_TIMESTAMP()
          AND (valid_to IS NULL OR valid_to > UTC_TIMESTAMP())`,
      [...variantIds, currency],
    );

    const priced = new Set(rows.map((row) => Number(row.variantId)));
    return variantIds.filter((id) => !priced.has(id));
  }
}
