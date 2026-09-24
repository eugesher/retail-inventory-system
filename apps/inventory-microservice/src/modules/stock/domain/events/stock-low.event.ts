import { DomainEvent } from '@retail-inventory-system/ddd';

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
