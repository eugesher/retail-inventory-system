import { ApiResponseProperty } from '@nestjs/swagger';

import { CartStatusEnum } from '../enums';

// RPC/HTTP response shape for a cart line. A **class** carrying
// `@ApiResponseProperty` (not a plain interface) so the gateway can declare it
// as a Swagger response type — `@nestjs/swagger` is the documented lib-contracts
// exception (ADR-017), mirroring `PriceView` / `ProductView`.
//
// `unitPriceSnapshotMinor` and `currencySnapshot` are the price as it stood when
// the line was added — captured at add-time and stable while sibling lines
// mutate (ADR-028 §1). `unitPriceSnapshotMinor` is an integer count of minor
// units (cents), never a float. `lineSubtotalMinor` is
// `unitPriceSnapshotMinor × quantity`.
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

// RPC/HTTP response shape for a whole cart. `customerId` is the gateway customer
// UUID (`null` for a guest cart); `currency` is the immutable CHAR(3) the cart
// was created in; `version` is the optimistic-concurrency token (shipped now
// though enforcement is a later concurrency-hardening capability, ADR-028 §6).
// `subtotalMinor` is the sum of the lines' `lineSubtotalMinor` — a convenience
// projection of `Cart.total` so the caller need not re-sum.
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
