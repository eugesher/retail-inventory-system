import { DomainEvent } from '@retail-inventory-system/ddd';

export class StockAllocatedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantity: number;
  public readonly orderId: number;
  public readonly reservationId: string | null;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantity: number;
    orderId: number;
    reservationId: string | null;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantity = props.quantity;
    this.orderId = props.orderId;
    this.reservationId = props.reservationId;
  }
}
