import { DomainEvent } from '@retail-inventory-system/ddd';

// Raised when Receive Stock raises a variant's on-hand at a location.
//
// `quantityDelta` is the amount received (always positive); `newOnHand` is the running total
// *after* the commit. One is a delta and the other an absolute — reading either for the other is
// the mistake this note exists to prevent. `actorId` is absent when a direct RMQ caller receives
// with no authenticated principal.
export class StockReceivedEvent extends DomainEvent<number> {
  public readonly stockLocationId: string;
  public readonly quantityDelta: number;
  public readonly newOnHand: number;
  public readonly actorId?: string;

  constructor(props: {
    variantId: number;
    stockLocationId: string;
    quantityDelta: number;
    newOnHand: number;
    actorId?: string;
  }) {
    super(props.variantId);
    this.stockLocationId = props.stockLocationId;
    this.quantityDelta = props.quantityDelta;
    this.newOnHand = props.newOnHand;
    this.actorId = props.actorId;
  }
}
