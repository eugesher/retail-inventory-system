import { DomainEvent } from '@retail-inventory-system/ddd';

// No producer wires this today; reserved so the publisher port surface
// stays stable for a future cancel flow.
export class OrderCancelledEvent extends DomainEvent<number> {
  public readonly customerId: number;
  public readonly reason?: string;

  constructor(props: { orderId: number; customerId: number; reason?: string }) {
    super(props.orderId);
    this.customerId = props.customerId;
    this.reason = props.reason;
  }
}
