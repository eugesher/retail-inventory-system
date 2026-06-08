import { DomainEvent } from '@retail-inventory-system/ddd';

// Fires when the auto-init consumer creates the first `stock_level` row for a
// freshly seen variant at a stock location (zeroed). `aggregateId` is the
// `variantId` — the downstream backbone key (ADR-027) — mirroring how
// `StockLowEvent` keys on its `productId`. `StockLevel` is not an
// `AggregateRoot`, so this event is constructed by the use case after the save
// commits rather than pulled from the aggregate (ADR-012 §carried-forward).
export class StockLevelInitializedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;

  constructor(props: { variantId: number; stockLocationId: string }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
  }
}
