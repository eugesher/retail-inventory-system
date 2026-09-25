import { DomainEvent } from '@retail-inventory-system/ddd';

export class StockAdjustedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantityDelta: number;
  public readonly reasonCode: string;
  public readonly newOnHand: number;
  public readonly actorId?: string;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantityDelta: number;
    reasonCode: string;
    newOnHand: number;
    actorId?: string;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantityDelta = props.quantityDelta;
    this.reasonCode = props.reasonCode;
    this.newOnHand = props.newOnHand;
    this.actorId = props.actorId;
  }
}
