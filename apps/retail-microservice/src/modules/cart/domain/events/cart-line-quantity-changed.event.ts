import { DomainEvent } from '@retail-inventory-system/ddd';

// Recorded by `Cart.changeLineQuantity(...)`. Carries the BIGINT `cart_line.id`
// and the new (positive) quantity; the base `aggregateId` carries the cart id.
// Mapped to the wire `retail.cart.line-quantity-changed`
// (`IRetailCartLineQuantityChangedEvent`) by the change use case — a
// `DomainEvent` subclass never crosses the wire (ADR-011).
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
