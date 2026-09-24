import { DomainEvent } from '@retail-inventory-system/ddd';

export class StockLevelInitializedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;

  constructor(props: { variantId: number; stockLocationId: string }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
  }
}
