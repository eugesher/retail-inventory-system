import { DomainEvent } from '@retail-inventory-system/ddd';

export interface IOrderConfirmedEventLine {
  orderProductId: number;
  productId: number;
}

// Fires when Order.confirm transitions the aggregate to CONFIRMED (i.e. every
// line item is confirmed). Reserved for future cross-service consumers — no
// subscriber today.
export class OrderConfirmedEvent extends DomainEvent<number> {
  public readonly customerId: number;
  public readonly lines: IOrderConfirmedEventLine[];

  constructor(props: { orderId: number; customerId: number; lines: IOrderConfirmedEventLine[] }) {
    super(props.orderId);
    this.customerId = props.customerId;
    this.lines = props.lines;
  }
}
