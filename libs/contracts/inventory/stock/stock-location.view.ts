import { ApiResponseProperty } from '@nestjs/swagger';

// The public projection of a `StockLocation`.
//
// `type` (`warehouse` / `store` / `dropship-virtual`) crosses the wire as a **plain string, not
// an enum**: `StockLocationTypeEnum` is an internal domain concept and is deliberately not a wire
// contract (ADR-025). A consumer that switches on it is switching on a string, and must handle a
// value it has not seen.
//
// `gln` is the 13-digit GLN or `null`. The location's **address is not projected here** — the
// view is an identity, not a dossier.
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
