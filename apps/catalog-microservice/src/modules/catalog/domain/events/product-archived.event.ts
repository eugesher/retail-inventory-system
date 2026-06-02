import { DomainEvent } from '@retail-inventory-system/ddd';

// Recorded by `Product.archive()` on the `active → archived` (terminal)
// transition. Archival is the catalog's soft-delete: the row stays resolvable,
// so downstream consumers may need to react (e.g. delist). The base
// `aggregateId` carries the product id.
export class ProductArchivedEvent extends DomainEvent<number> {
  constructor(props: { productId: number }) {
    super(props.productId);
  }

  public get productId(): number {
    return this.aggregateId;
  }
}
