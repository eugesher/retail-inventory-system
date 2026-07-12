import { ReservationReleaseReason } from '@retail-inventory-system/contracts';
import { DomainEvent } from '@retail-inventory-system/ddd';

// Raised when a release returns held units to `available` (ADR-030).
//
// **`cartId` and `reservationId` are both nullable, because a release does not always come from a
// hold.** Cancelling an order releases by order (`CancelAllocationUseCase`), and the sweep releases
// by expiry — neither has a cart or a single reservation to name. A consumer keying on `cartId`
// silently drops both. **`reason` is the discriminator** that tells the paths apart, and it is the
// only one.
export class StockReleasedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantity: number;
  public readonly cartId: string | null;
  public readonly reservationId: string | null;
  public readonly reason: ReservationReleaseReason;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantity: number;
    cartId: string | null;
    reservationId: string | null;
    reason: ReservationReleaseReason;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantity = props.quantity;
    this.cartId = props.cartId;
    this.reservationId = props.reservationId;
    this.reason = props.reason;
  }
}
