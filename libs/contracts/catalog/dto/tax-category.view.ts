import { ApiResponseProperty } from '@nestjs/swagger';

// RPC response shape for the tax-category operations (`catalog.tax-category.create`
// returns the persisted label; `catalog.tax-category.list` returns an array of
// these). It is a **class** carrying `@ApiResponseProperty` (not a plain
// interface) so the gateway can declare it as `@ApiOkResponse({ type:
// TaxCategoryView })` — `@nestjs/swagger` is the documented lib-contracts
// exception (ADR-017), mirroring `PriceView` / `ProductView`.
//
// A tax category is a classification label only: a stable `code`
// (UPPER_SNAKE_CASE), a human `name`, and an optional `description`. It carries no
// rate or jurisdiction — tax computation is a deferred future capability (ADR-026).
export class TaxCategoryView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public code: string;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public description: string | null;
}
