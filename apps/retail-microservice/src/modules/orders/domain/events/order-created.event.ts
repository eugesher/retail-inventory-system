import { DomainEvent } from '@retail-inventory-system/ddd';

export interface IOrderCreatedEventLine {
  productId: number;
  quantity: number;
}

// Constructed by `CreateOrderUseCase` after the repository round-trip
// assigns the aggregate id (ADR-013 §5) — the aggregate cannot fabricate
// its own id at create-time.
export class OrderCreatedEvent extends DomainEvent<number> {
  public readonly lines: IOrderCreatedEventLine[];

  constructor(props: { orderId: number; lines: IOrderCreatedEventLine[] }) {
    super(props.orderId);
    this.lines = props.lines;
  }
}
