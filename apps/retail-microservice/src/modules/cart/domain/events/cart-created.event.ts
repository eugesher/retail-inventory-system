import { DomainEvent } from '@retail-inventory-system/ddd';

// Recorded by `Cart.create(...)`. The base `aggregateId` carries the cart's
// CHAR(36) UUID (generated in-app at create, so it is concrete from the start —
// unlike the catalog variant id, which is null until persistence assigns it).
//
// A `DomainEvent` subclass is never serialized across services (ADR-011): the
// create use case maps this in-process event to the wire `retail.cart.created`
// (`IRetailCartCreatedEvent`) after persistence.
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
