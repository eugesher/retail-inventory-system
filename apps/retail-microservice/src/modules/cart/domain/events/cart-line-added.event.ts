import { DomainEvent } from '@retail-inventory-system/ddd';

export class CartLineAddedEvent extends DomainEvent<string> {
  public readonly variantId: number;
  public readonly quantity: number;

  constructor(props: { cartId: string; variantId: number; quantity: number }) {
    super(props.cartId);
    this.variantId = props.variantId;
    this.quantity = props.quantity;
  }

  public get cartId(): string {
    return this.aggregateId;
  }
}
