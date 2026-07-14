import { ApiResponseProperty } from '@nestjs/swagger';

import { StockMovementTypeEnum } from '../enums';

// One `stock_movement` row — the audit ledger's read projection.
//
// `quantity` is **signed**, and the sign is fixed per movement type (ADR-030 §2): positive for
// receipt/return, negative for sale/allocation/release, either-but-never-zero for adjustment. A
// consumer summing this column gets the net delta, not the throughput.
//
// `referenceType` / `referenceId` pair a movement with the business document that caused it —
// `cart`, `order`, `transfer`, `return-request`. It is a **plain string, not an enum**, and the
// pair carries **no foreign key** (the polymorphic `media_asset.owner_id` precedent, ADR-029): do
// not join on it.
//
// `actorId` is `null` for a **system** action — the auto-init and the sweeper have no principal.
export class StockMovementView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public stockLocationId: string;

  @ApiResponseProperty()
  public type: StockMovementTypeEnum;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public reasonCode: string | null;

  @ApiResponseProperty()
  public referenceType: string | null;

  @ApiResponseProperty()
  public referenceId: string | null;

  @ApiResponseProperty()
  public actorId: string | null;

  @ApiResponseProperty()
  public occurredAt: string;
}
