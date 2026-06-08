import { DomainEvent } from '@retail-inventory-system/ddd';

// Fires when a variant's on-hand quantity at a stock location sits at or below
// `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD` after a write. Re-keyed onto the new
// model (ADR-027): `aggregateId` is the `variantId` (the downstream backbone
// key), and `stockLocationId` replaces the retired `storageId`. `quantity` is the
// post-commit `StockLevel.quantityOnHand`. `StockLevel` is not an `AggregateRoot`,
// so the Adjust use case constructs this event after the save commits rather than
// pulling it from the aggregate (ADR-012 §carried-forward).
export class StockLowEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantity: number;
  public readonly threshold: number;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantity: number;
    threshold: number;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantity = props.quantity;
    this.threshold = props.threshold;
  }
}
