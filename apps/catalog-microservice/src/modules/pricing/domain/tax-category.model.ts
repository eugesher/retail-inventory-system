import { Entity } from '@retail-inventory-system/ddd';

import { PricingDomainException, PricingErrorCodeEnum } from './pricing.exception';

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export interface ITaxCategoryProps {
  id: number | null;
  code: string;
  name: string;
  description?: string | null;
}

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

  public static create(props: {
    code: string;
    name: string;
    description?: string | null;
  }): TaxCategory {
    return new TaxCategory({ id: null, ...props });
  }

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
