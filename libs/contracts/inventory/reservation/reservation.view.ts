import { ApiResponseProperty } from '@nestjs/swagger';

// RPC/HTTP response shape for one `reservation` row — the TTL-bounded, cart-scoped
// hold (ADR-030). A **class** carrying `@ApiResponseProperty` (not a plain
// interface) so the gateway can declare it as a Swagger response type —
// `@nestjs/swagger` is the documented lib-contracts exception (ADR-005 / ADR-017),
// mirroring `StockLevelView` / `StockMovementView`.
//
// `status` is the **raw string union**, not the domain `ReservationStatusEnum`:
// the lifecycle enum stays in the inventory `domain/` and the wire carries its
// string value (the `CategoryStatusEnum` convention, ADR-025 §7). `expiresAt` is
// the ISO-8601 instant the hold lapses.
export class ReservationView {
  @ApiResponseProperty()
  public reservationId: string;

  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public stockLocationId: string;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public cartId: string;

  @ApiResponseProperty()
  public expiresAt: string;

  @ApiResponseProperty()
  public status: 'active' | 'committed' | 'released' | 'expired';
}
