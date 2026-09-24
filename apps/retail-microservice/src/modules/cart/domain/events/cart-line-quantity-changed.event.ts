import { DomainEvent } from '@retail-inventory-system/ddd';

export class CartLineQuantityChangedEvent extends DomainEvent<string> {
  public readonly lineId: number;
  public readonly quantity: number;

  constructor(props: { cartId: string; lineId: number; quantity: number }) {
    super(props.cartId);
    this.lineId = props.lineId;
    this.quantity = props.quantity;
  }

  public get cartId(): string {
    return this.aggregateId;
  }
}
