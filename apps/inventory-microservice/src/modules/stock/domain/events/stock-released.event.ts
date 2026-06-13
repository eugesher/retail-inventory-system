import { ReservationReleaseReason } from '@retail-inventory-system/contracts';
import { DomainEvent } from '@retail-inventory-system/ddd';

// Fires when a Release returns held units to `available` (ADR-030). `aggregateId`
// is the `variantId`; `quantity` is the (positive) amount returned, `reason` why
// the hold was released. `cartId` / `reservationId` are **nullable** so the later
// order-cancel emitter (which releases by order, not a single hold) can omit them
// — the by-cart / by-id Release paths of this capability always set both.
// `ReservationReleaseReason` is a wire union from `libs/contracts`; the domain may
// import `libs/{ddd,common,contracts}` (ADR-017).
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
