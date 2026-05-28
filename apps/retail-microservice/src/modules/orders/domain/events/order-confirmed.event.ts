import { DomainEvent } from '@retail-inventory-system/ddd';

export interface IOrderConfirmedEventLine {
  orderProductId: number;
  productId: number;
}

// No cross-service subscriber today; the port surface is reserved.
export class OrderConfirmedEvent extends DomainEvent<number> {
  public readonly lines: IOrderConfirmedEventLine[];

  constructor(props: { orderId: number; lines: IOrderConfirmedEventLine[] }) {
    super(props.orderId);
    this.lines = props.lines;
  }
}
