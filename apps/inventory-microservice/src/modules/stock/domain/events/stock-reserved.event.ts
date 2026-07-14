import { DomainEvent } from '@retail-inventory-system/ddd';

// Raised when Reserve holds stock for a cart (ADR-030). **A hold, not a sale** — nothing has left
// `quantity_on_hand`.
//
// `quantity` is the **absolute** held amount for the `(cartId, variantId, stockLocationId)` triple
// after the reserve, not the increment this call added.
//
// `expiresAt` is when the TTL lapses. The hold does not release itself at that instant — the sweep
// does, later, and raises a `StockReleasedEvent` when it gets there. Between the two moments the
// units are still held and `available` is still short of them.
export class StockReservedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantity: number;
  public readonly cartId: string;
  public readonly reservationId: string;
  public readonly expiresAt: Date;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantity: number;
    cartId: string;
    reservationId: string;
    expiresAt: Date;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantity = props.quantity;
    this.cartId = props.cartId;
    this.reservationId = props.reservationId;
    this.expiresAt = props.expiresAt;
  }
}
