import { ApiResponseProperty } from '@nestjs/swagger';

// RPC response shape for the price operations (`catalog.price.set` returns the
// persisted row; `catalog.price.list` returns an array of these;
// `catalog.price.select` returns one or `null`). It is a **class** carrying
// `@ApiResponseProperty` (not a plain interface) so the gateway can declare it as
// `@ApiOkResponse({ type: PriceView })` — `@nestjs/swagger` is the documented
// lib-contracts exception (ADR-017), mirroring `ProductView`.
//
// `amountMinor` is an integer count of minor units (cents). `validFrom` is the
// ISO-8601 interval start; `validTo` is the ISO-8601 close instant or `null` for
// an open-ended (currently-in-effect) row. `priority` is the resolution tiebreak.
export class PriceView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public currency: string;

  @ApiResponseProperty()
  public amountMinor: number;

  @ApiResponseProperty()
  public validFrom: string;

  @ApiResponseProperty()
  public validTo: string | null;

  @ApiResponseProperty()
  public priority: number;
}
