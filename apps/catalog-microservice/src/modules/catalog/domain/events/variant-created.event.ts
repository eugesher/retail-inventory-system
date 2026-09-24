import { DomainEvent } from '@retail-inventory-system/ddd';

export class VariantCreatedEvent extends DomainEvent<number> {
  public readonly sku: string;

  constructor(props: { productId: number; sku: string }) {
    super(props.productId);
    this.sku = props.sku;
  }

  public get productId(): number {
    return this.aggregateId;
  }
}
