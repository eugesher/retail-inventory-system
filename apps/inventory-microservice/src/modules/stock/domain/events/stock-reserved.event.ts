import { DomainEvent } from '@retail-inventory-system/ddd';

// Reserved against a confirmed order. Aggregate id is the productId;
// events are scoped to the (productId, storageId) pair.
export class StockReservedEvent extends DomainEvent<number> {
  public readonly storageId: string;
  public readonly orderProductId: number;
  public readonly quantity: number;

  constructor(props: {
    productId: number;
    storageId: string;
    orderProductId: number;
    quantity: number;
  }) {
    super(props.productId);
    this.storageId = props.storageId;
    this.orderProductId = props.orderProductId;
    this.quantity = props.quantity;
  }
}
