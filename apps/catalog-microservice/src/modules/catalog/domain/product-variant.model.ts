import { Entity } from '@retail-inventory-system/ddd';

import { CatalogDomainException, CatalogErrorCodeEnum } from './catalog.exception';
import { Dimensions } from './dimensions.vo';
import { OptionValues } from './option-values.vo';
import { ProductVariantStatusEnum } from './product-variant-status.enum';

export interface IProductVariantProps {
  id: number | null;
  productId: number | null;
  sku: string;
  gtin?: string | null;
  optionValues: Record<string, string>;
  weightG?: number | null;
  dimensionsMm?: { l: number; w: number; h: number } | null;
  status?: ProductVariantStatusEnum;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

// A ProductVariant is the sellable, stocked, priced unit and the downstream
// backbone key (inventory stock, pricing, and order lines key on `variantId`,
// not the product). On the write path it is a *child entity* of the Product
// aggregate root — never persisted or mutated on its own; the Product root adds
// and validates it (ADR-025). On the read path a variant is addressable
// top-level, but that is a separate read model, not a second write aggregate.
export class ProductVariant extends Entity<number | null> {
  private _productId: number | null;
  private readonly _sku: string;
  private readonly _gtin: string | null;
  private readonly _optionValues: OptionValues;
  private readonly _weightG: number | null;
  private readonly _dimensions: Dimensions | null;
  private _status: ProductVariantStatusEnum;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  constructor(props: IProductVariantProps) {
    if (typeof props.sku !== 'string' || props.sku.trim().length === 0) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.VARIANT_SKU_REQUIRED,
        'ProductVariant.sku must be a non-empty string',
      );
    }
    if (
      props.weightG !== undefined &&
      props.weightG !== null &&
      (!Number.isInteger(props.weightG) || props.weightG < 0)
    ) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.VARIANT_WEIGHT_INVALID,
        `ProductVariant.weightG must be a non-negative integer when present, got ${props.weightG}`,
      );
    }

    super(props.id);
    this._productId = props.productId;
    this._sku = props.sku;
    // Normalize an empty/whitespace gtin to null. MySQL's `UNIQUE (gtin)` permits
    // multiple NULLs but not multiple ''; an absent gtin arriving as '' (an
    // optional field left blank at the edge) would otherwise be stored verbatim
    // and collide on the second variant, surfacing as a raw driver 500 (ADR-025).
    const trimmedGtin = props.gtin?.trim() ?? '';
    this._gtin = trimmedGtin.length > 0 ? trimmedGtin : null;
    // The VO constructors carry the non-empty-map and non-negative-mm invariants.
    this._optionValues = new OptionValues(props.optionValues);
    this._weightG = props.weightG ?? null;
    this._dimensions = props.dimensionsMm ? new Dimensions(props.dimensionsMm) : null;
    this._status = props.status ?? ProductVariantStatusEnum.ACTIVE;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public get productId(): number | null {
    return this._productId;
  }

  public get sku(): string {
    return this._sku;
  }

  public get gtin(): string | null {
    return this._gtin;
  }

  // Exposes the raw map (the shape persistence and the read model want); the VO
  // stays internal as the validated holder.
  public get optionValues(): Record<string, string> {
    return this._optionValues.value;
  }

  public get weightG(): number | null {
    return this._weightG;
  }

  public get dimensionsMm(): { l: number; w: number; h: number } | null {
    return this._dimensions ? this._dimensions.value : null;
  }

  public get status(): ProductVariantStatusEnum {
    return this._status;
  }

  public isActive(): boolean {
    return this._status === ProductVariantStatusEnum.ACTIVE;
  }
}
