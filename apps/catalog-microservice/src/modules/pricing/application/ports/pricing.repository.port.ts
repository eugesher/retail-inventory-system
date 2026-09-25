import { VariantTaxHeaderView } from '@retail-inventory-system/contracts';

import { Price, TaxCategory } from '../../domain';

export const PRICING_REPOSITORY = Symbol('PRICING_REPOSITORY');

export interface IPricingRepositoryPort {
  findOpenPrice(variantId: number, currency: string): Promise<Price | null>;

  appendPrice(newPrice: Price, predecessorToClose: Price | null): Promise<Price>;

  findInEffect(variantId: number, currency: string, asOf: Date): Promise<Price[]>;

  createTaxCategory(taxCategory: TaxCategory): Promise<TaxCategory>;
  listTaxCategories(): Promise<TaxCategory[]>;
  findTaxCategoryByCode(code: string): Promise<TaxCategory | null>;

  attachTaxCategoryToVariant(variantId: number, taxCategoryId: number): Promise<void>;

  findVariantTaxHeader(variantId: number): Promise<VariantTaxHeaderView | null>;
}
