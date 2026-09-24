import { ReservationReleaseReason } from '@retail-inventory-system/contracts';
import { DomainEvent } from '@retail-inventory-system/ddd';

export class StockReleasedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantity: number;
  public readonly cartId: string | null;
  public readonly reservationId: string | null;
  public readonly reason: ReservationReleaseReason;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantity: number;
    cartId: string | null;
    reservationId: string | null;
    reason: ReservationReleaseReason;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantity = props.quantity;
    this.cartId = props.cartId;
    this.reservationId = props.reservationId;
    this.reason = props.reason;
  }
}
