import { DomainEvent } from '@retail-inventory-system/ddd';

export class CartCreatedEvent extends DomainEvent<string> {
  public readonly customerId: string | null;
  public readonly currency: string;

  constructor(props: { cartId: string; customerId: string | null; currency: string }) {
    super(props.cartId);
    this.customerId = props.customerId;
    this.currency = props.currency;
  }

  public get cartId(): string {
    return this.aggregateId;
  }
}
