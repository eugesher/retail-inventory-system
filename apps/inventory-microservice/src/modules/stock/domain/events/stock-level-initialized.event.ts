import { DomainEvent } from '@retail-inventory-system/ddd';

// Raised when the catalog-events consumer creates the first `stock_level` row for a variant it has
// not seen before.
//
// **The row is ZEROED.** Its existence says nothing about availability — a consumer must not read
// this as "stock arrived". What it means is that inventory now has somewhere to put stock for this
// variant.
export class StockLevelInitializedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;

  constructor(props: { variantId: number; stockLocationId: string }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
  }
}
