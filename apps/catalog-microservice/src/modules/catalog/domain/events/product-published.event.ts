import { DomainEvent } from '@retail-inventory-system/ddd';

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
