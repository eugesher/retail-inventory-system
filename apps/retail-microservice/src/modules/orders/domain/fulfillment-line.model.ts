import { Entity } from '@retail-inventory-system/ddd';

import { OrderDomainException, OrderErrorCodeEnum } from './order.exception';

export interface IFulfillmentLineProps {
  id: number | null;
  fulfillmentId: number | null;
  orderLineId: number;
  quantity: number;
}

export class FulfillmentLine extends Entity<number | null> {
  public readonly fulfillmentId: number | null;
  public readonly orderLineId: number;
  public readonly quantity: number;

  constructor(props: IFulfillmentLineProps) {
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
