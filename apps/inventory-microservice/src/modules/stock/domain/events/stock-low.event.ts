import { DomainEvent } from '@retail-inventory-system/ddd';

// Fires when (productId, storageId) quantity sits at-or-below
// `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`.
export class StockLowEvent extends DomainEvent<number> {
  public readonly storageId: string;
  public readonly quantity: number;
  public readonly threshold: number;

  constructor(props: {
    productId: number;
    storageId: string;
    quantity: number;
    threshold: number;
  }) {
    super(props.productId);
    this.storageId = props.storageId;
    this.quantity = props.quantity;
    this.threshold = props.threshold;
  }
}
