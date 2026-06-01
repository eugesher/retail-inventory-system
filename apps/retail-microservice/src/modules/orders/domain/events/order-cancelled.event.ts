import { DomainEvent } from '@retail-inventory-system/ddd';

// No producer wires this today; reserved so the publisher port surface
// stays stable for a future cancel flow.
export class OrderCancelledEvent extends DomainEvent<number> {
  public readonly reason?: string;

  constructor(props: { orderId: number; reason?: string }) {
    super(props.orderId);
    this.reason = props.reason;
  }
}
