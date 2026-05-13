import { DomainEvent } from '@retail-inventory-system/ddd';

// Emitted when a previously-reserved quantity is released back to available
// stock (e.g. order cancellation). No producer wires this today — the event
// type exists so the release path has a stable shape when it is added.
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
