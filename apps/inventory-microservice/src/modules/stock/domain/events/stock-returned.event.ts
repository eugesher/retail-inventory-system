import { DomainEvent } from '@retail-inventory-system/ddd';

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
