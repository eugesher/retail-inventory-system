import { DomainEvent } from '@retail-inventory-system/ddd';

// Reserved for the future cancel flow (task-09 brief defers the cancel
// use-case). The event exists so the publisher port surface is stable; the
// only producer that would emit it does not exist today.
export class OrderCancelledEvent extends DomainEvent<number> {
  public readonly customerId: number;
  public readonly reason?: string;

  constructor(props: { orderId: number; customerId: number; reason?: string }) {
    super(props.orderId);
    this.customerId = props.customerId;
    this.reason = props.reason;
  }
}
