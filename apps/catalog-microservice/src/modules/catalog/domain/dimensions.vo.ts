import { ValueObject } from '@retail-inventory-system/ddd';

import { CatalogDomainException, CatalogErrorCodeEnum } from './catalog.exception';

interface IDimensionsProps extends Record<string, unknown> {
  l: number;
  w: number;
  h: number;
}

// Physical bounding box in millimetres. Each axis is a non-negative integer —
// symmetric with the `weightG` invariant (grams, non-negative integer). The
// field is optional on a variant; an absent box is `null`, never a
// zero-valued Dimensions, so "unknown size" and "zero size" stay distinct.
export class Dimensions extends ValueObject<IDimensionsProps> {
  constructor(props: IDimensionsProps) {
    for (const axis of ['l', 'w', 'h'] as const) {
      const value = props[axis];
      if (!Number.isInteger(value) || value < 0) {
        throw new CatalogDomainException(
          CatalogErrorCodeEnum.VARIANT_DIMENSIONS_INVALID,
          `Dimensions.${axis} must be a non-negative integer (mm), got ${value}`,
        );
      }
    }

    super({ l: props.l, w: props.w, h: props.h });
  }

  public get l(): number {
    return this.props.l;
  }

  public get w(): number {
    return this.props.w;
  }

  public get h(): number {
    return this.props.h;
  }

  public get value(): { l: number; w: number; h: number } {
    return { l: this.props.l, w: this.props.w, h: this.props.h };
  }
}
