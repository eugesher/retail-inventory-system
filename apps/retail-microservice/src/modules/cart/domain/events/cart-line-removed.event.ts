import { DomainEvent } from '@retail-inventory-system/ddd';

// Recorded by `Cart.removeLine(...)`. Carries the BIGINT `cart_line.id` of the
// dropped line; the base `aggregateId` carries the cart id. Mapped to the wire
// `retail.cart.line-removed` (`IRetailCartLineRemovedEvent`) by the remove use
// case — a `DomainEvent` subclass never crosses the wire (ADR-011).
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
