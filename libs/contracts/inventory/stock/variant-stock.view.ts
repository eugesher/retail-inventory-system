import { ApiResponseProperty } from '@nestjs/swagger';

import { StockLevelView } from './stock-level.view';

// RPC response shape for `inventory.stock-level.get`, and the **cached value**
// behind the `v3` stock cache key. It projects one variant's availability across
// the requested stock locations: each `locations[]` entry is one `StockLevel`
// row, and the two totals are the cross-location aggregate.
//
// `totalOnHand` / `totalAvailable` are summed over `locations` by the read use
// case (`totalAvailable` is the sum of each location's derived `available`). An
// empty `locations` array — a variant with no stock-level rows for the requested
// scope — is a valid value with both totals `0`.
//
// This replaces the deleted product-keyed `ProductStockGetResponseDto`. The shape
// change (per-product `SUM` aggregate → per-variant projection) is exactly what
// forced the cache-key schema-version bump `v1 → v2` (ADR-022); a later
// reservation-driven change to the value's semantics bumped it again to `v3`
// (ADR-030 §7), which is the live version.
export class VariantStockView {
  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public totalOnHand: number;

  @ApiResponseProperty()
  public totalAvailable: number;

  @ApiResponseProperty({ type: [StockLevelView] })
  public locations: StockLevelView[];
}
