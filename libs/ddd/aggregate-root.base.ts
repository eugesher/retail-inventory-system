import { DomainEvent } from './domain-event.base';
import { Entity } from './entity.base';

// A buffer of what the aggregate decided, drained by whoever is going to act on it.
//
// **The USE CASE drains it, not the repository** (ADR-025), after the repository round-trip. No
// repository adapter in this codebase calls `pullDomainEvents()` and none should: the wire event
// is built in the application layer, which is the layer that knows the persisted ids — for
// `catalog.variant.created` that placement is load-bearing, not stylistic.
//
// **Drain from the instance that RECORDED the events.** A repository's `save` hands back a
// reconstituted aggregate — `BaseTypeormRepository.save` is `toDomain(await repo.save(…))`, and
// reconstitution records nothing — so `(await repo.save(x)).pullDomainEvents()` is always empty.
// Nothing throws: the row commits, the response is correct, and the event is silently never
// published. Keep the mutated aggregate in a local and drain from that one.
//
// **Publication is best-effort at-most-once** (ADR-020), not exactly-once. Every publish sits in
// a try/catch after the local commit and a broker failure is warn-logged and swallowed. There is
// no outbox: ADR-035 and ADR-036 each considered a transactional one and rejected it for this
// scope, so a dropped event stays dropped and the code that publishes must be written knowing it.
//
// What pull-and-drain does buy is narrower than it sounds: a second `save` cannot re-publish what
// the first one already drained.
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
