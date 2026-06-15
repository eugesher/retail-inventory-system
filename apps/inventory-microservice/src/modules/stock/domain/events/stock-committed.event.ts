import { DomainEvent } from '@retail-inventory-system/ddd';

// Fires when a Commit Sale ships an order's allocated stock at fulfillment time
// (ADR-031). `aggregateId` is the `variantId` (the downstream backbone key);
// `quantity` is the shipped quantity for the line, `orderId` the order being
// fulfilled, and `fulfillmentId` the shipment that triggered the commit — the
// idempotency anchor (the `sale` movement references it). `StockLevel` is not an
// `AggregateRoot`, so the Commit Sale use case constructs this event after the
// save commits rather than pulling it from a model (the `StockAllocatedEvent`
// precedent).
export class StockCommittedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantity: number;
  public readonly orderId: number;
  public readonly fulfillmentId: string;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantity: number;
    orderId: number;
    fulfillmentId: string;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantity = props.quantity;
    this.orderId = props.orderId;
    this.fulfillmentId = props.fulfillmentId;
  }
}
