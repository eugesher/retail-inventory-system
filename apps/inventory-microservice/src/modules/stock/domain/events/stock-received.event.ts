import { DomainEvent } from '@retail-inventory-system/ddd';

// Fires when a Receive Stock operation raises a variant's on-hand quantity at a
// stock location (ADR-027). `aggregateId` is the `variantId` (the downstream
// backbone key); `quantityDelta` is the positive amount received and `newOnHand`
// the post-commit running total. `actorId` is the staff user who performed the
// receive (optional). `StockLevel` is not an `AggregateRoot`, so the use case
// constructs this event after the save commits rather than pulling it from the
// aggregate (ADR-012 §carried-forward).
export class StockReceivedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantityDelta: number;
  public readonly newOnHand: number;
  public readonly actorId?: string;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantityDelta: number;
    newOnHand: number;
    actorId?: string;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantityDelta = props.quantityDelta;
    this.newOnHand = props.newOnHand;
    this.actorId = props.actorId;
  }
}
