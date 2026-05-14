import { DomainEvent } from '@retail-inventory-system/ddd';

export interface IOrderCreatedEventLine {
  productId: number;
  quantity: number;
}

// Fires after Order.create succeeds. The publisher adapter transforms this
// in-process event into the wire-format `IRetailOrderCreatedEvent` consumed
// by the notification microservice (see ROUTING_KEYS.RETAIL_ORDER_CREATED).
export class OrderCreatedEvent extends DomainEvent<number> {
  public readonly customerId: number;
  public readonly lines: IOrderCreatedEventLine[];

  constructor(props: { orderId: number; customerId: number; lines: IOrderCreatedEventLine[] }) {
    super(props.orderId);
    this.customerId = props.customerId;
    this.lines = props.lines;
  }
}
