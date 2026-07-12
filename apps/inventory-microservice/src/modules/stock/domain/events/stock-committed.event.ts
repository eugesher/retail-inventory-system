import { DomainEvent } from '@retail-inventory-system/ddd';

// **The one event on which stock physically leaves.** A commit decrements `quantity_on_hand` *and*
// `quantity_allocated` together (ADR-031); every earlier event in the reserve → allocate chain only
// moved counters between columns.
//
// `fulfillmentId` is the idempotency anchor — the `sale` movement references it, so replaying a
// commit for the same shipment decrements nothing.
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
