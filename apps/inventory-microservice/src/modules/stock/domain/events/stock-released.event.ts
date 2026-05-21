import { DomainEvent } from '@retail-inventory-system/ddd';

// Released back to available stock (e.g. order cancellation). No producer
// wires this today — type reserved for the release path.
export class StockReleasedEvent extends DomainEvent<number> {
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
