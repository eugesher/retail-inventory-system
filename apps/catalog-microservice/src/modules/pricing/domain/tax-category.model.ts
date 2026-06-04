import { Entity } from '@retail-inventory-system/ddd';

import { PricingDomainException, PricingErrorCodeEnum } from './pricing.exception';

// UPPER_SNAKE_CASE: a leading uppercase letter, then uppercase letters, digits,
// or underscores (e.g. `STANDARD`, `REDUCED_RATE`, `ZERO_RATED`).
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export interface ITaxCategoryProps {
  id: number | null;
  code: string;
  name: string;
  description?: string | null;
}

// A `TaxCategory` is a classification label only — a stable code plus a human
// name. It carries NO rate, jurisdiction, or conversion logic; computing tax is
// a separate future capability (ADR-026). A variant points at one tax category
// through the nullable `product_variant.tax_category_id` FK (the attach use case
// lands later); the link is opaque from here.
//
// Global `code` uniqueness is a REPOSITORY-level invariant (a UNIQUE constraint
// + a use-case pre-check), not enforced in the model — the model cannot see
// other rows. This mirrors the catalog `slug`/`sku` convention (ADR-025).
export class TaxCategory extends Entity<number | null> {
  private readonly _code: string;
  private readonly _name: string;
  private readonly _description: string | null;

  private constructor(props: ITaxCategoryProps) {
    if (typeof props.code !== 'string' || !CODE_PATTERN.test(props.code)) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.TAX_CATEGORY_CODE_INVALID,
        `TaxCategory.code must be UPPER_SNAKE_CASE matching ^[A-Z][A-Z0-9_]*$, got "${props.code}"`,
      );
    }
    if (typeof props.name !== 'string' || props.name.trim().length === 0) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.TAX_CATEGORY_NAME_REQUIRED,
        'TaxCategory.name must be a non-empty string',
      );
    }

    super(props.id);
    this._code = props.code;
    this._name = props.name;
    this._description = props.description ?? null;
  }

  // The write path: a brand-new category with no id yet. Uniqueness of `code` is
  // checked by the use case against the repository before this is persisted.
  public static create(props: {
    code: string;
    name: string;
    description?: string | null;
  }): TaxCategory {
    return new TaxCategory({ id: null, ...props });
  }

  // Rebuilds a persisted row from storage. Records nothing.
  public static reconstitute(props: ITaxCategoryProps): TaxCategory {
    return new TaxCategory(props);
  }

  public get code(): string {
    return this._code;
  }

  public get name(): string {
    return this._name;
  }

  public get description(): string | null {
    return this._description;
  }
}
