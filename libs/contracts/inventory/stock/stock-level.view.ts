import { ApiResponseProperty } from '@nestjs/swagger';

// One location's slice of a variant's availability — the per-location element of
// `VariantStockView.locations`. It is a **class** carrying `@ApiResponseProperty`
// (not a plain interface) so the gateway can declare it as a nested response type
// (`@ApiResponseProperty({ type: [StockLevelView] })`) — `@nestjs/swagger` is the
// documented lib-contracts exception (ADR-005 / ADR-017), mirroring `PriceView`.
//
// `available` is the derived sellable count (`quantityOnHand − quantityAllocated
// − quantityReserved`); it is projected onto the view by the read use case, not
// stored. `version` is the optimistic-lock token (advances on every write).
// `updatedAt` is the row's last-write instant, or `null` for a never-persisted
// (zeroed) level.
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
