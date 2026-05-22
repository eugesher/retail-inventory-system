import { randomUUID } from 'crypto';

// Transport-agnostic — serialization onto a routing key is a transport-layer
// concern (libs/messaging); this base makes no assumptions about the broker.
export abstract class DomainEvent<TAggregateId = number> {
  public readonly id: string;
  public readonly occurredAt: Date;
  public readonly aggregateId: TAggregateId;

  protected constructor(aggregateId: TAggregateId) {
    this.id = randomUUID();
    this.occurredAt = new Date();
    this.aggregateId = aggregateId;
  }
}
