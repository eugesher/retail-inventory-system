import { ApiResponseProperty } from '@nestjs/swagger';

import { CartStatusEnum } from '../enums';

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
