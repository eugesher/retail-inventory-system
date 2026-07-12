import { ApiResponseProperty } from '@nestjs/swagger';

// One location's slice of a variant's availability.
//
// `available` is **derived, not stored**: `quantityOnHand − quantityAllocated − quantityReserved`,
// projected onto the view by the read use case. Do not expect a column behind it, and do not
// expect it to be reconcilable by adding a fourth counter. `updatedAt` is `null` for a level that
// has never been persisted — a zeroed placeholder.
export class StockLevelView {
  @ApiResponseProperty()
  public stockLocationId: string;

  @ApiResponseProperty()
  public quantityOnHand: number;

  @ApiResponseProperty()
  public quantityAllocated: number;

  @ApiResponseProperty()
  public quantityReserved: number;

  @ApiResponseProperty()
  public available: number;

  @ApiResponseProperty()
  public version: number;

  @ApiResponseProperty()
  public updatedAt: Date | null;
}
