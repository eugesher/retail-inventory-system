import { Entity } from '@retail-inventory-system/ddd';

import { OrderDomainException, OrderErrorCodeEnum } from './order.exception';

export interface IFulfillmentLineProps {
  id: number | null;
  // The owning fulfillment's BIGINT id — `null` until persistence assigns the
  // parent (a freshly built line on a freshly built fulfillment), concrete after a
  // load. A child entity does not carry its parent's id in the persistence mapping
  // (the relation does), but the domain keeps it so a reconstituted line can be
  // reasoned about standalone.
  fulfillmentId: number | null;
  orderLineId: number;
  quantity: number;
}

// One line of a `Fulfillment` and a *child entity* of the `Fulfillment` aggregate
// root — never persisted or mutated on its own; the root holds and validates it
// (the `OrderLine` precedent, ADR-028). It says which `OrderLine` quantity is in
// this shipment: a partial shipment carries fewer units than the line's ordered
// quantity, the remainder shipping in a later fulfillment (ADR-031).
//
// `orderLineId` is the link back to the placed order's line; the FK that ties it to
// `order_line(id)` lives only in persistence — the line is plain domain data here.
// The `number | null` id mirrors `OrderLine` / `CartLine`: null before persistence
// assigns the BIGINT, concrete after a load.
//
// Unlike `OrderLine` it is NOT `Object.freeze`d — it is not a money snapshot, and it
// is a child of a mutable-status parent (the fulfillment's status walks
// `pending → shipped → delivered`); the quantity is fixed at create but the row's
// parent is not immutable, so freezing would buy nothing and only complicate the
// load path. Records no events (a child entity, not an `AggregateRoot`).
export class FulfillmentLine extends Entity<number | null> {
  public readonly fulfillmentId: number | null;
  public readonly orderLineId: number;
  public readonly quantity: number;

  constructor(props: IFulfillmentLineProps) {
    // The model enforces only its own shape — the `quantity` invariant. Whether
    // `orderLineId` actually names a line on the order is a cross-aggregate check
    // the Create use case owns (it resolves the order to validate it), not something
    // the standalone line can see (ADR-031).
    if (!Number.isInteger(props.quantity) || props.quantity <= 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_LINE_QUANTITY_INVALID,
        `FulfillmentLine.quantity must be a positive integer, got ${props.quantity}`,
      );
    }

    super(props.id);
    this.fulfillmentId = props.fulfillmentId;
    this.orderLineId = props.orderLineId;
    this.quantity = props.quantity;
  }
}
