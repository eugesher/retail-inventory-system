import { DomainEvent } from '@retail-inventory-system/ddd';

// Raised when Allocate turns a hold into a firm allocation for an order (ADR-030 §4). Still not a
// sale — the units are spoken for, but nothing has left `quantity_on_hand`.
//
// **`reservationId` is `null` on the direct-allocation path.** An order can allocate stock it never
// held: a line that was never reserved, or one whose hold had gone stale and was re-balanced
// through `available`. A consumer must not read the null as a broken join.
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
