import { DomainEvent } from '@retail-inventory-system/ddd';

// Fires when a Reserve operation holds stock for a cart (ADR-030). `aggregateId`
// is the `variantId` (the downstream backbone key); `quantity` is the absolute
// held quantity for the `(cartId, variantId, stockLocationId)` triple after the
// reserve, `reservationId` the hold's UUID, and `expiresAt` the TTL instant.
// `StockLevel`/`Reservation` are not `AggregateRoot`s, so the Reserve use case
// constructs this event after the save commits rather than pulling it from a model
// (ADR-012 §carried-forward; the `StockReceivedEvent` precedent).
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
