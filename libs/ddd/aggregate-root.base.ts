import { DomainEvent } from './domain-event.base';
import { Entity } from './entity.base';

// Repository adapters drain `pullDomainEvents()` post-persist and dispatch
// them on an outbox / messaging bus. Pull-and-drain semantics ensure
// exactly-once publish on subsequent saves and keep aggregates transport-free.
export abstract class AggregateRoot<TId> extends Entity<TId> {
  private _domainEvents: DomainEvent<TId>[] = [];

  protected addDomainEvent(event: DomainEvent<TId>): void {
    this._domainEvents.push(event);
  }

  public pullDomainEvents(): DomainEvent<TId>[] {
    const events = this._domainEvents;
    this._domainEvents = [];
    return events;
  }
}
