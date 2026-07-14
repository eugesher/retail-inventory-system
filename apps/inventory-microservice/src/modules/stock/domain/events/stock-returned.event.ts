import { DomainEvent } from '@retail-inventory-system/ddd';

// The mirror of `StockCommittedEvent`: on-hand rises, and only rises (ADR-032).
//
// **Only `restock`-disposition lines get here.** Goods scrapped or quarantined at inspection never
// re-enter sellable inventory and raise nothing — so counting these events counts what came *back
// to the shelf*, not what came back to the warehouse.
//
// `returnRequestId` is the idempotency anchor; the `return` movement references it.
export class StockReturnedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantity: number;
  public readonly returnRequestId: number;
  public readonly returnLineId: number;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantity: number;
    returnRequestId: number;
    returnLineId: number;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantity = props.quantity;
    this.returnRequestId = props.returnRequestId;
    this.returnLineId = props.returnLineId;
  }
}
