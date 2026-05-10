import { randomUUID } from 'crypto';

// Domain event base — framework-free. Subclasses set `aggregateId` and
// payload-specific fields. The transport layer (libs/messaging) is
// responsible for serializing these onto a routing key; this file makes no
// assumptions about RabbitMQ or any other broker.
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
