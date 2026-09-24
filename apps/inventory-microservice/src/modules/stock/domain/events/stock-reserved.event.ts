import { DomainEvent } from '@retail-inventory-system/ddd';

export class StockReservedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantity: number;
  public readonly cartId: string;
  public readonly reservationId: string;
  public readonly expiresAt: Date;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantity: number;
    cartId: string;
    reservationId: string;
    expiresAt: Date;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantity = props.quantity;
    this.cartId = props.cartId;
    this.reservationId = props.reservationId;
    this.expiresAt = props.expiresAt;
  }
}
