import { DomainEvent } from '@retail-inventory-system/ddd';

// Fires when an Allocate operation commits a hold into a firm allocation for an
// order (ADR-030 §4). `aggregateId` is the `variantId` (the downstream backbone
// key); `quantity` is the allocated quantity for the line, `orderId` the order the
// units are picked for, and `reservationId` the hold that was committed — or
// **null** on the direct-allocation fallback path (no prior reservation existed,
// e.g. an order line never reserved, or a wall-clock-stale hold the use case
// re-balanced through `available`). `StockLevel`/`Reservation` are not
// `AggregateRoot`s, so the Allocate use case constructs this event after the save
// commits rather than pulling it from a model (the `StockReservedEvent` precedent).
export class StockAllocatedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantity: number;
  public readonly orderId: number;
  public readonly reservationId: string | null;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantity: number;
    orderId: number;
    reservationId: string | null;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantity = props.quantity;
    this.orderId = props.orderId;
    this.reservationId = props.reservationId;
  }
}
