import { ApiResponseProperty } from '@nestjs/swagger';

import { CartStatusEnum } from '../enums';

// The price snapshot is taken when the line is ADDED and stays put while sibling lines mutate
// (ADR-028 §1) — re-pricing a cart is not a thing that happens on its own. Every `*Minor` field
// is an integer count of minor units, never a float.
export class CartLineView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public unitPriceSnapshotMinor: number;

  @ApiResponseProperty()
  public currencySnapshot: string;

  @ApiResponseProperty()
  public lineSubtotalMinor: number;
}

// `customerId` is `null` for a guest cart. `version` is the OCC token: a caller may pin it in an
// `If-Match` to make a lost race surface as a conflict instead of silently resolving to a
// different outcome (ADR-036). `subtotalMinor` is a convenience projection of `Cart.total`, so
// the caller need not re-sum the lines.
export class CartView {
  @ApiResponseProperty()
  public id: string;

  @ApiResponseProperty()
  public customerId: string | null;

  @ApiResponseProperty()
  public currency: string;

  @ApiResponseProperty()
  public status: CartStatusEnum;

  @ApiResponseProperty()
  public expiresAt: string | null;

  @ApiResponseProperty()
  public version: number;

  @ApiResponseProperty({ type: [CartLineView] })
  public lines: CartLineView[];

  @ApiResponseProperty()
  public subtotalMinor: number;
}
