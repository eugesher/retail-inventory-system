# ADR-060: What drains a domain event, and the test double that could not fail

- **Date**: 2026-09-10
- **Status**: Accepted

---

## Context

`libs/ddd/aggregate-root.base.ts` is the base class every aggregate in six services extends. Three
lines sat above it:

> *Repository adapters drain `pullDomainEvents()` post-persist and dispatch them on an outbox /
> messaging bus. Pull-and-drain semantics ensure exactly-once publish on subsequent saves and keep
> aggregates transport-free.*

All three claims were false.

| Claim | What the codebase does |
| --- | --- |
| *Repository adapters drain … post-persist* | **No adapter drains.** `grep pullDomainEvents` across every `infrastructure/` folder and `libs/database` returns nothing. [ADR-025](025-catalog-product-and-variant-aggregate.md) places the drain in the **use case**, and the catalog walkthrough marks that placement *"on purpose"* — the wire event needs the persisted `variantId`, which only the layer that re-reads it knows. |
| *dispatch them on an outbox* | There is no outbox. [ADR-035](035-event-store-firehose-topic-exchange.md) and [ADR-036](036-idempotency-key-store-and-enforced-occ.md) each considered a transactional one and rejected it for this scope. |
| *ensure exactly-once publish* | The guarantee is **at-most-once**, best-effort ([ADR-020](020-rabbitmq-as-inter-service-bus.md)): every publish sits in a try/catch after the local commit, and a broker failure is warn-logged and swallowed. |

### Why a wrong comment here costs more than a wrong comment elsewhere

Every correct drain in this repository lives inside a use case of a specific module —
`create-cart.use-case.ts`, `archive-product.use-case.ts` — where nobody looks until they already
know to look. The base class is the one place the mechanism is described **for someone writing a
new aggregate**, and it told them persistence would publish on their behalf.

That is not a hypothetical cost. A module written from scratch against this comment did exactly
what it says: the aggregate recorded its creation event, the use case drained the value the
repository handed back, and the event was **never published**. `save` returns a *reconstituted*
aggregate — `BaseTypeormRepository.save` is `toDomain(await repo.save(…))` — and reconstitution
records nothing, so the drain was over an empty buffer. Nothing threw. The row committed, the HTTP
response was correct, the log was clean. It surfaced only because a downstream consumer's rows
were missing.

### The specs that could not have caught it

Three IAM use-case specs asserted the recorded event off the **return value of `save`**:

```ts
const result = await useCase.execute({ staffUserId: 'staff-1', roleNames: ['admin'] });
const events = result.pullDomainEvents();          // ← empty in production, always
expect(assignedEvent?.assignedRoleNames).toEqual(['admin']);
```

They were green because `InMemoryStaffUserRepository.save` ended in `return Promise.resolve(user)`
— the same object — while `StaffUserTypeormRepository.save` ends in
`StaffUserMapper.toDomain(reloaded)`, a different one. **The double and the adapter had different
identity semantics, and the specs were asserting the double's.**

The third was worse than wrong. `expect(assignedEvent).toBeUndefined()` — "no event on an
idempotent re-assign" — is satisfied by a buffer that is empty for the wrong reason, so once the
double was corrected it stayed green **vacuously**: a test that can no longer fail, sitting in a
suite as evidence.

## Decision

### 1. The comment states the contract as it is

Four points, none of them a restatement of the taxonomy: the **use case** drains, after the
repository round-trip (ADR-025); **drain from the instance that recorded the events**, because a
`save` return carries none; publication is **at-most-once best-effort** with no outbox (ADR-020 /
035 / 036), so a dropped event stays dropped and the caller must be written knowing it; and what
pull-and-drain does buy is only that a second `save` cannot re-publish what the first drained.

The last point matters because it is the one true sentence the old comment contained, and deleting
it would invite someone to re-add the false three around it.

### 2. Event-recording assertions move onto the aggregate's own spec

`staff-user.model.spec.ts` gains three cases for `recordRolesAssigned` / `recordRoleRevoked` —
including the empty-diff case, which is where "records nothing" is a real assertion rather than a
vacuous one. The IAM use-case specs keep what they legitimately test: the resulting role set, and
the `AUDIT_LOG_PUBLISHER` publish, which is the **effective** audit surface for these mutations.

### 3. A test double reproduces its adapter's identity semantics

The rule, stated so it outlives this file: **where the real adapter returns a reconstituted
aggregate, its in-memory double returns one too.** A double that hands back its own argument is
not merely simpler — it grants specs an ability production does not have, and the specs that use
it are unfalsifiable rather than passing.

The IAM doubles now clone before returning and drain the clone. The clone is deliberate: draining
the **caller's** aggregate instead would have been simpler and wrong, because it would break the
*correct* pattern — keep the mutated aggregate in a local, drain from that — which is what every
working use case in the repository does.

### 4. What is deliberately not changed

The six `StaffUser` / `Customer` domain events nothing drains stay as they are. That is a recorded
decision, not an oversight:
[`05-iam-admin-endpoints.md`](../implementation/01-baseline-identity-staffuser-customer-rbac/05-iam-admin-endpoints.md)
calls the queue *"latent scaffolding"* and names `AUDIT_LOG_PUBLISHER.publish(...)` as the
effective audit surface. This ADR corrects how the mechanism is described; it does not wire it.

## Alternatives Considered

**Fix only the comment.** The cheapest reading of the defect, and it leaves three specs asserting a
fiction — one of them a test that cannot fail. The comment was the cause; the specs are the reason
nobody noticed, and a cause fixed without its detector is a cause that recurs.

**Make repository adapters drain and dispatch, so the old comment becomes true.** Rejected: ADR-025
placed the drain in the application layer for a reason that has not changed — the wire event needs
ids that only the post-persist re-read knows — and there is no outbox to dispatch onto, which is
itself a rejected decision (ADR-035/036), not a gap.

**Have the in-memory double drain the caller's aggregate rather than clone it.** Fewer lines, and
it would make the correct pattern fail: a use case that keeps the mutated aggregate and drains it
after `save` — the pattern this ADR endorses — would find its buffer emptied by the double. A
double must be stricter than production, never differently shaped.

**Assert the events in the use-case spec by reading them back through the double.** The same
identity coupling with an extra step; the assertion still cannot hold against the real adapter.

## Consequences

### Positive

- The one place a new aggregate's author reads about events now describes the mechanism that
  exists, including the failure mode that produced this ADR.
- The three IAM assertions are replaced by three on the aggregate, where they are falsifiable —
  verified by mutation: removing the `addDomainEvent` from `recordRolesAssigned` turns one red.
- A rule with a name for the double / adapter mismatch, so the ten remaining sites can be judged
  rather than rediscovered.

### Negative / Trade-offs

- `asReconstituted` is a reflective clone (`Object.create(Object.getPrototypeOf(x))` plus
  `Object.assign`), which is the kind of thing that reads as clever in a test double. The
  alternative — a real `rehydrate` round-trip per aggregate — needs each double to know how to
  rebuild its aggregate's props, which is more machinery for the same guarantee.
- The IAM use-case specs now say less about domain events than they appeared to. That is the
  point, but the diff reads as lost coverage until you find the three cases that replaced them.

### Open

- **Ten more `save` methods in four double files still return their argument**
  (`auth` ×4, `register-staff-user.use-case.spec.ts` ×3, catalog ×2, pricing ×1). None of them is
  currently exploited — no other spec drains events off a `save` return — so this is a latent
  mismatch, not a live defect, and it is left for its own change rather than folded in here.

## References

- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — best-effort, at-most-once publication.
- [ADR-025](025-catalog-product-and-variant-aggregate.md) — the drain and the wire mapping belong
  to the application layer.
- [ADR-035](035-event-store-firehose-topic-exchange.md),
  [ADR-036](036-idempotency-key-store-and-enforced-occ.md) — a transactional outbox, considered and
  rejected, twice.
- [ADR-045](045-one-occ-retry-protocol.md) — the sibling case of a protocol whose one true home is
  a shared helper rather than a comment on a base class.
