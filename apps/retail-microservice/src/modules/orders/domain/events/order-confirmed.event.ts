import { DomainEvent } from '@retail-inventory-system/ddd';

export interface IOrderConfirmedEventLine {
  orderProductId: number;
  productId: number;
}

// No cross-service subscriber today; the port surface is reserved.
export class OrderConfirmedEvent extends DomainEvent<number> {
  public readonly customerId: number;
  public readonly lines: IOrderConfirmedEventLine[];

  constructor(props: { orderId: number; customerId: number; lines: IOrderConfirmedEventLine[] }) {
    super(props.orderId);
    this.customerId = props.customerId;
    this.lines = props.lines;
  }
}
