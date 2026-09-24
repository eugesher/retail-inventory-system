import { ValueObject } from '@retail-inventory-system/ddd';

import { CatalogDomainException, CatalogErrorCodeEnum } from './catalog.exception';

interface IOptionValuesProps extends Record<string, unknown> {
  values: Record<string, string>;
}

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

  public get value(): Record<string, string> {
    return { ...this.props.values };
  }
}
