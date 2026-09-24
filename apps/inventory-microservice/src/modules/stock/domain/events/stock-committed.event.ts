import { DomainEvent } from '@retail-inventory-system/ddd';

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
