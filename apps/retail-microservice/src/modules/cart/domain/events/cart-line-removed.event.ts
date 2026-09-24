import { DomainEvent } from '@retail-inventory-system/ddd';

export class CartLineRemovedEvent extends DomainEvent<string> {
  public readonly lineId: number;

  constructor(props: { cartId: string; lineId: number }) {
    super(props.cartId);
    this.lineId = props.lineId;
  }

  public get cartId(): string {
    return this.aggregateId;
  }
}
