import { DomainEvent } from './domain-event.base';
import { Entity } from './entity.base';

// Aggregate root extends Entity with the ability to record domain events.
// Repository adapters drain `pullDomainEvents()` after persistence and
// dispatch them on a transactional outbox / messaging bus. Pull semantics
// keep the aggregate framework-free.
export abstract class AggregateRoot<TId> extends Entity<TId> {
  private _domainEvents: DomainEvent[] = [];

  protected addDomainEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
  }

  public pullDomainEvents(): DomainEvent[] {
    const events = this._domainEvents;
    this._domainEvents = [];
    return events;
  }

  public get domainEvents(): readonly DomainEvent[] {
    return this._domainEvents;
  }
}
