import { ApiResponseProperty } from '@nestjs/swagger';

import { StockMovementTypeEnum } from '../enums';

// RPC/HTTP response shape for one `stock_movement` row — the audit ledger's read
// projection. A **class** carrying `@ApiResponseProperty` (not a plain interface)
// so the gateway can declare it as a Swagger response type — `@nestjs/swagger` is
// the documented lib-contracts exception (ADR-005 / ADR-017), mirroring
// `StockLevelView`.
//
// `quantity` is **signed** (the per-type sign of ADR-030 §2: positive for
// receipt/return, negative for sale/allocation/release, either non-zero for
// adjustment). `reasonCode` carries the operator's reason on an `adjustment` (or a
// release reason), null otherwise.
//
// `referenceType` / `referenceId` pair a movement with the business document that
// caused it — documented values for `referenceType` are `cart` / `order` /
// `transfer` / `return-request`. It is deliberately a **plain string, not an
// enum**: the reference vocabulary grows with later capabilities, and the pair
// carries NO foreign key (the polymorphic `media_asset.owner_id` / retail
// `address` precedent, ADR-029). `actorId` is the staff/customer id that triggered
// the movement, or `null` for a **system** action (auto-init, sweeper). `occurredAt`
// is the ISO-8601 instant the movement was recorded.
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
