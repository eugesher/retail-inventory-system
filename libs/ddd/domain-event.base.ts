import { randomUUID } from 'crypto';

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
