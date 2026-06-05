import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IActivePriceProbePort } from '../../application/ports';
import { ProductVariantEntity } from './product-variant.entity';

// The raw-query row shape: a single `variant_id` per priced variant. mysql2 may
// surface a non-PK BIGINT as a string, so the column is typed loosely and coerced
// in the method. Typing the `manager.query<...>` generic with this row avoids an
// `any` leak (no `as` cast) and a `no-unsafe-assignment` on the result.
interface IPricedVariantRow {
  variantId: number | string;
}

// Answers the publish use case's "which of these variants lack an in-effect
// price?" question by reading the pricing-owned `price` table directly with a
// PARAMETERIZED query. It injects the catalog `ProductVariantEntity` repository
// purely for its shared `EntityManager` — the query targets `price`, never the
// variant table — and imports nothing from the pricing module. That is the whole
// point: the catalog module cannot import a pricing entity/model (a cross-module
// infrastructure import the boundaries lint rejects, ADR-017), so the `price`
// table + the opaque `variantId` are the only coupling. This is the exact mirror
// of `PricingTypeormRepository`, which injects its own `PriceEntity` repository
// and writes the catalog-owned `product_variant.tax_category_id` the same way
// (ADR-025 / ADR-026 §5).
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
    // No variants to check → nothing missing. Short-circuiting also keeps the
    // SQL valid: an empty `IN ()` list is a syntax error in MySQL. The domain
    // (`Product.publish()`) owns the ≥1-variant rule, so a variant-less product
    // is still rejected downstream — just not here.
    if (variantIds.length === 0) {
      return [];
    }

    // A `?` placeholder per id, built from the array *length* (never the values),
    // so every id and the currency are driver-bound parameters rather than
    // string-concatenated SQL. `UTC_TIMESTAMP()` evaluates "now" in the DB so the
    // probe needs no injected clock. The `[validFrom, validTo)` containment test
    // mirrors the pricing repository's `findInEffect` candidate query — a row is
    // in effect when it has started and has not yet closed.
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

    // Coerce the (possibly string) BIGINT back to a number, then diff the
    // requested ids against the priced set — what remains has no active price.
    const priced = new Set(rows.map((row) => Number(row.variantId)));
    return variantIds.filter((id) => !priced.has(id));
  }
}
