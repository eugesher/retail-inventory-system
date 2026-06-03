import { DomainEvent } from '@retail-inventory-system/ddd';

// Recorded by `Product.publish()` on the `draft → active` transition. Publish
// always runs against an already-persisted product, so `variantIds` are
// concrete (null ids are filtered out by the aggregate before the event is
// constructed). The base `aggregateId` carries the product id.
export class ProductPublishedEvent extends DomainEvent<number> {
  public readonly slug: string;
  public readonly variantIds: number[];

  constructor(props: { productId: number; slug: string; variantIds: number[] }) {
    super(props.productId);
    this.slug = props.slug;
    this.variantIds = props.variantIds;
  }

  public get productId(): number {
    return this.aggregateId;
  }
}
