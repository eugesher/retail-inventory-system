import { DomainEvent } from '@retail-inventory-system/ddd';

// Raised when Adjust Stock applies a delta to a variant's on-hand at a location.
//
// `quantityDelta` is **signed** — an adjustment is the one movement type that may go either way.
// `newOnHand` is the running total after the commit.
//
// `reasonCode` is mandatory. It rides the event *and* the `adjustment` `StockMovement` row the use
// case appends in the same transaction (ADR-030), so a consumer knows *why* the delta happened
// without joining the ledger to find out.
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
