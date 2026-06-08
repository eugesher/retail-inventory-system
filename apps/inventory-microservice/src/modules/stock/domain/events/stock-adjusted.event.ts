import { DomainEvent } from '@retail-inventory-system/ddd';

// Fires when an Adjust Stock operation applies a signed delta to a variant's
// on-hand quantity at a stock location (ADR-027). `aggregateId` is the
// `variantId`; `quantityDelta` is the signed adjustment and `newOnHand` the
// post-commit running total. `reasonCode` is the mandatory audit reason carried
// on the event (and in logs) — no `StockMovement` audit row is written today;
// that ledger lands with a later capability. `actorId` is the staff user who
// performed the adjustment (optional). `StockLevel` is not an `AggregateRoot`, so
// the use case constructs this event after the save commits (ADR-012
// §carried-forward).
export class StockAdjustedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantityDelta: number;
  public readonly reasonCode: string;
  public readonly newOnHand: number;
  public readonly actorId?: string;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantityDelta: number;
    reasonCode: string;
    newOnHand: number;
    actorId?: string;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantityDelta = props.quantityDelta;
    this.reasonCode = props.reasonCode;
    this.newOnHand = props.newOnHand;
    this.actorId = props.actorId;
  }
}
