import { DomainEvent } from '@retail-inventory-system/ddd';

// Fires when a Restock from Return puts a return request's `restock`-disposition
// stock back on-hand (ADR-032). `aggregateId` is the `variantId` (the downstream
// backbone key); `quantity` is the restocked quantity for the line (strictly
// positive — on-hand only rises), `returnRequestId` the RMA whose inspection
// triggered the restock — the idempotency anchor (the `return` movement references
// it) — and `returnLineId` the specific line that was restocked. `StockLevel` is
// not an `AggregateRoot`, so the Restock use case constructs this event after the
// save commits rather than pulling it from a model (the `StockCommittedEvent`
// precedent).
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
