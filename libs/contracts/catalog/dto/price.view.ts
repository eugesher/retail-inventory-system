import { ApiResponseProperty } from '@nestjs/swagger';

// `amountMinor` is an integer count of minor units, never a float. `validTo` is `null` for an
// open-ended row — the one currently in effect. `priority` breaks a tie when two rows both apply.
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
