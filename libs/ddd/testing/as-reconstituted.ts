import { AggregateRoot } from '../aggregate-root.base';

// **A `save` that hands back its own argument is a double that lies in the caller's favour.**
//
// Every real repository returns a RECONSTITUTED aggregate — `BaseTypeormRepository.save` ends in
// `toDomain(await repo.save(...))`, `StaffUserTypeormRepository.save` in
// `StaffUserMapper.toDomain(reloaded)` — and reconstitution records no domain events. So
// `(await repo.save(x)).pullDomainEvents()` is empty in production, always. An in-memory double
// that returns the same object it was given makes that expression carry events, and a spec written
// against it asserts something the system can never do. Such a spec does not pass; it is
// unfalsifiable. ADR-060 records the case where three of them were.
//
// The rule this helper exists to make cheap: **where the real adapter returns a reconstituted
// aggregate, its double returns one too.**
//
// It clones rather than draining the argument, deliberately. Draining the caller's aggregate would
// be shorter and would break the CORRECT pattern — keep the mutated aggregate in a local and drain
// that after `save` — which every working use case in the repository relies on. A double must be
// stricter than production, never differently shaped.
//
// The clone is prototype-preserving and shallow: same class, same fields, empty event buffer. That
// is the whole of what reconstitution changes for a spec's purposes; it is not a persistence
// round-trip and does not pretend to be one (ids the DB would assign, columns it would default —
// a double that needs those builds them itself, as the catalog and cart doubles do).
// `TId` is a second type parameter rather than `AggregateRoot<never>` or `AggregateRoot<unknown>`:
// the base class holds a private `DomainEvent<TId>[]`, which makes `TId` invariant, so no single
// instantiation is a supertype of every aggregate. Both parameters are inferred from the argument.
export const asReconstituted = <TId, T extends AggregateRoot<TId>>(aggregate: T): T => {
  const clone = Object.assign(
    Object.create(Object.getPrototypeOf(aggregate) as object) as T,
    aggregate,
  );
  clone.pullDomainEvents();
  return clone;
};
