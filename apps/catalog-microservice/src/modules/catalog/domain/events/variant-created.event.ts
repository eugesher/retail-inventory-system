import { DomainEvent } from '@retail-inventory-system/ddd';

// Recorded by `Product.addVariant(...)`. The base `aggregateId` carries the
// owning product's id.
//
// `variantId` is `number | null`: a freshly added variant has no id until the
// repository assigns one. The use case maps this in-process event to the wire
// `catalog.variant.created` event AFTER persistence, re-reading the concrete id
// from the saved aggregate — a `DomainEvent` subclass is never serialized
// across services (ADR-011 / ADR-025). `sku` is always known at add-time.
export class VariantCreatedEvent extends DomainEvent<number> {
  public readonly variantId: number | null;
  public readonly sku: string;

  constructor(props: { productId: number; variantId: number | null; sku: string }) {
    super(props.productId);
    this.variantId = props.variantId;
    this.sku = props.sku;
  }

  public get productId(): number {
    return this.aggregateId;
  }
}
