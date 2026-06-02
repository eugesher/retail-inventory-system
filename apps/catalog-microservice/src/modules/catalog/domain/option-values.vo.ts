import { ValueObject } from '@retail-inventory-system/ddd';

import { CatalogDomainException, CatalogErrorCodeEnum } from './catalog.exception';

interface IOptionValuesProps extends Record<string, unknown> {
  values: Record<string, string>;
}

// The set of option name/value pairs that distinguish a variant within its
// product — e.g. `{ color: 'red', size: 'M' }`. The map MUST be non-empty: a
// variant with no distinguishing options is not a meaningful sellable unit
// (a single-variant product still names at least one option, even if trivial).
//
// Modelled as a value object rather than a bare `Record` so the "non-empty map
// of non-empty string→string pairs" invariant has one home; the base
// `ValueObject` freezes the props for structural equality (JSON-stable).
export class OptionValues extends ValueObject<IOptionValuesProps> {
  constructor(values: Record<string, string>) {
    const entries = Object.entries(values ?? {});

    if (entries.length === 0) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.VARIANT_OPTION_VALUES_REQUIRED,
        'ProductVariant.optionValues must be a non-empty map',
      );
    }
    for (const [key, value] of entries) {
      if (
        typeof key !== 'string' ||
        key.trim().length === 0 ||
        typeof value !== 'string' ||
        value.trim().length === 0
      ) {
        throw new CatalogDomainException(
          CatalogErrorCodeEnum.VARIANT_OPTION_VALUES_REQUIRED,
          `ProductVariant.optionValues entries must be non-empty strings (offending key "${key}")`,
        );
      }
    }

    super({ values: { ...values } });
  }

  // Returns a defensive copy — the base freeze is shallow, so handing out the
  // internal record directly would let a caller mutate it.
  public get value(): Record<string, string> {
    return { ...this.props.values };
  }
}
