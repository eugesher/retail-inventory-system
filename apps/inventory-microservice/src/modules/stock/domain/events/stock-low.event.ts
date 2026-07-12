import { DomainEvent } from '@retail-inventory-system/ddd';

// **The one inventory event with a real consumer** — the notification service binds it for an ops
// alert. Every other event in this folder is a reserved surface.
//
// **It fires on the way DOWN, and only on the way down.** The emitter requires a negative delta
// *and* a resulting on-hand at or below the threshold. A level already below and simply sitting
// there raises nothing; nor does a partial restock that leaves it below. **Silence is not evidence
// that stock is healthy** — it means nothing crossed the line just now.
//
// `quantity` is the post-commit `quantityOnHand`.
export class StockLowEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantity: number;
  public readonly threshold: number;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantity: number;
    threshold: number;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantity = props.quantity;
    this.threshold = props.threshold;
  }
}
