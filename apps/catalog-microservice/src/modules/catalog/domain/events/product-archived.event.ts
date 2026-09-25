import { DomainEvent } from '@retail-inventory-system/ddd';

export class ProductArchivedEvent extends DomainEvent<number> {
  constructor(props: { productId: number }) {
    super(props.productId);
  }

  public get productId(): number {
    return this.aggregateId;
  }
}
