import { DomainEvent } from '@retail-inventory-system/ddd';

// Recorded by `Cart.addLine(...)` — both when a new line is appended and when an
// existing line for the same variant is incremented (the increment-existing
// path, ADR-028 §1). `quantity` is the amount added in this call (the delta),
// not the resulting line quantity. The base `aggregateId` carries the cart id.
//
// Mapped to the wire `retail.cart.line-added` (`IRetailCartLineAddedEvent`) by
// the add use case — a `DomainEvent` subclass never crosses the wire (ADR-011).
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
