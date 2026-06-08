import { ApiResponseProperty } from '@nestjs/swagger';

// RPC response element for `inventory.location.list` — the public projection of a
// `StockLocation` aggregate. A **class** with `@ApiResponseProperty` so the
// gateway can declare it as a response type (ADR-005 / ADR-017), mirroring the
// catalog view DTOs.
//
// `type` is the location kind (`warehouse` / `store` / `dropship-virtual`),
// carried as a plain string on the wire — the `StockLocationTypeEnum` is an
// internal domain concept, not a wire contract (the catalog `*StatusEnum`
// precedent, ADR-025). `gln` is the 13-digit GLN or `null`. `address` is omitted
// from the view for now — add it later if a consumer needs it.
export class StockLocationView {
  @ApiResponseProperty()
  public id: string;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public code: string;

  @ApiResponseProperty()
  public type: string;

  @ApiResponseProperty()
  public gln: string | null;

  @ApiResponseProperty()
  public active: boolean;
}
