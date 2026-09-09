# ADR-059: Deleting the routing-key mirror enum, and the test that was pinning a snapshot

- **Date**: 2026-09-10
- **Status**: Accepted

---

## Context

[ADR-008](008-rabbitmq-via-libs-messaging.md) introduced `ROUTING_KEYS` as a *"frozen `as const`
object mirroring `MicroserviceMessagePatternEnum`"*, and kept the enum on an explicit promise:

> *existing callers using `MicroserviceMessagePatternEnum` keep working.*

[ADR-009](009-port-adapter-at-the-gateway.md) then made `ROUTING_KEYS` the rule for new code and
named what remained:

> *This is a fresh-write rule — this work did not flip existing call sites in microservices,
> **that's a later focused cleanup pass**.*

The cleanup pass happened in the code and not in the repository. Today `ROUTING_KEYS` is imported
by **53** files across all six apps. `MicroserviceMessagePatternEnum` is imported by **one**: its
own spec. The compatibility it was kept for is compatibility with callers that no longer exist —
[ADR-046](046-libs-layout-and-dead-export-removal.md)'s sentence, in its original tense: *a
deletion queued behind a condition, with no owner and no check, is not queued; it is forgotten.*

Meanwhile the enum's own header had drifted the other way:

> *Kept in lock-step with `ROUTING_KEYS` … **this enum is the source of truth**, `ROUTING_KEYS` is
> the idiomatic constants surface for new callers.*

Every implementation doc that mentions it calls it *"the back-compat enum"* or *"the legacy
`MicroserviceMessagePatternEnum`"*. The file at the bottom of the stack was the only thing still
claiming to be at the top.

### The five missing keys are policy, not drift

`ROUTING_KEYS` holds 117 entries; the enum held 112. The five absent —
`AUDIT_STAFF_ACTION`, `CUSTOMER_CONSENT_UPDATED`, `CUSTOMER_ERASED`, `MARKETING_EMAIL_PROMO`,
`NOTIFICATION_MARKETING_SEND` — were all added after 2026-06-27, and the omission was **deliberate**
and recorded the first time it happened
([`11-.../02-topic-exchange-ris-events-and-dual-publish.md`](../implementation/11-event-store-and-audit-log/02-topic-exchange-ris-events-and-dual-publish.md)):

> *The legacy `MicroserviceMessagePatternEnum` mirror is intentionally **not** extended for it —
> that enum is a back-compat surface only, and a brand-new event has no prior consumer to keep
> compatible.*

That reasoning is correct, and the following four keys followed it. So the two surfaces were not
drifting apart by accident; they were being **deliberately allowed to diverge**, key by key,
because one of them had a shrinking purpose.

### The test was pinning a snapshot and calling it lock-step

`libs/messaging/spec/routing-keys.constants.spec.ts` was 320 lines: **112** hand-written
`expect(ROUTING_KEYS.X).toBe(MicroserviceMessagePatternEnum.X)` assertions — one per enum member —
plus a dotted-regex check.

That form can see exactly one failure: *a value changed, under a name present on both sides.* It
cannot see a key that exists on one side only, because a key it does not mention is a key it does
not test. Five such keys existed. The suite was green throughout, and its 112 lines read to a
reviewer as thoroughness.

What the green actually asserted, unstated, was: *keys that existed on 2026-06-27 agree; later ones
need not.* Nobody decided that. It is simply what a table of literals means once the world moves
and the table does not — the same defect as the mirrored taxonomy that
[`spec/architecture-lint.spec.ts`](../../spec/architecture-lint.spec.ts) removed, where 74 green
tests certified a config CI was not running.

## Decision

### 1. `MicroserviceMessagePatternEnum` is deleted

The file and its `libs/contracts/microservices/index.ts` barrel line. `ROUTING_KEYS` is the sole
declaration of a routing key; `RoutingKey` (already exported, `(typeof ROUTING_KEYS)[keyof typeof
ROUTING_KEYS]`) is the union type, **derived** from the values rather than declared beside them.

### 2. The spec asserts invariants, and names no key

Four tests, 47 lines, none of which mention an individual routing key — **add a key tomorrow and
this file does not change**:

1. **The registry is non-empty.** A guard, not a formality: every other test here loops, and a loop
   over `{}` is green.
2. **Every constant name derives from its wire value** — `name === value.replace(/[.-]/g, '_')
   .toUpperCase()`. This holds for all 117 entries and is the load-bearing one: it ties the two
   halves of an entry to each other, so a typo in *either* fails, including on a key that does not
   exist yet. It is the invariant the mirror enum was standing in for, and unlike the enum it costs
   nothing to maintain.
3. **Every value matches the dotted lower-case convention** (ADR-008) — kept from the old suite.
4. **No two names map onto one wire key** — two logical operations indistinguishable on the bus is
   a failure mode no pairwise mirror check ever covered.

Verified by mutation, not by reading:

| change | old suite | new suite |
| --- | --- | --- |
| typo in a value (`retail.cart.creat`) | red | red |
| two names on one value | red | red |
| **new key with a mismatched name** | **green** — the key is not in the table | **red** |
| new key, correctly named | green | green |

The third row is the whole point.

### 3. The implementation docs stop describing a mirror

Twenty references across thirteen files under [`docs/implementation/`](../implementation/) said the
keys "live in **both**" surfaces, "kept value-for-value", "asserted by the spec". All are rewritten
to the single declaration. The ADRs are **not** rewritten — they are dated records
([ADR-003](003-record-architecture-decisions.md)) — and instead ADR-008 and ADR-009 each gain a
one-line `Status` pointer here.

## Alternatives Considered

**Keep the enum; fix the spec to a set bijection** (`new Set(Object.values(A))` equals
`new Set(Object.values(B))`) and add the five missing keys. This was the fallback the audit
proposed before the history was read, and the history refutes it: the five omissions were *right*.
A bijection test would force every future key onto a surface whose only purpose is compatibility
with callers that do not exist, and would make the correct decision recorded in the event-store
walkthrough into a CI failure.

**Keep the enum and assert nothing.** Two declarations of one fact, one of them unused and
unchecked — [ADR-046](046-libs-layout-and-dead-export-removal.md) /
[ADR-048](048-two-scaffold-adapters-that-were-never-wired.md) /
[ADR-049](049-the-port-methods-nothing-calls.md) exist because that arrangement has cost and no
benefit.

**Delete the enum but keep 117 literal assertions against `ROUTING_KEYS`.** The same table again
with one side removed: it would still need a line per key, still say nothing about the next one,
and still read as thoroughness.

**Assert the three-segment `<service>.<aggregate>.<action>` shape.** `customer.erased` has two
segments, so the rule needs an exception list on day one — and an exception list is the
hand-maintained table this ADR is removing.

**Assert that the first segment is a known service namespace.** `marketing.email.promo` is not a
routing key at all — it is the template-registry `eventType` (ADR-037), and it is the one entry in
the map that never rides a queue. Same objection: the rule is born with an exception.

## Consequences

### Positive

- A routing key is declared once. Adding one is a single line, and no test, doc or second surface
  has to be updated in step.
- The suite now fails on a class of error it structurally could not see before — a name that does
  not match its value, on a key added after the test was written.
- 320 lines and 112 assertions become 47 lines and 4 tests, with strictly more coverage.
- `docs/implementation/` no longer describes a mirror that does not exist.

### Negative / Trade-offs

- The name-derivation invariant makes an implicit convention **binding**: a key whose constant name
  is not the upper-snake of its value now fails CI. Every one of the 117 already complies, and the
  rule is what makes the second surface unnecessary — but ADR-008 never wrote it down as a rule,
  and this ADR does.
- A consumer wanting a nominal TypeScript `enum` of routing keys no longer has one. `RoutingKey`
  covers the type-level need; anything else would be re-declaring the values.

### Open

- None. The `ROUTING_KEYS` ↔ `MicroserviceQueueEnum` relationship ("the namespace names the queue")
  is deliberately **not** asserted: an event is published onto the *consumer's* queue rather than
  its own (ADR-008/020), so namespace and queue genuinely differ for events, and a test asserting
  otherwise would be wrong.

## References

- [ADR-008](008-rabbitmq-via-libs-messaging.md) — created both surfaces and kept the enum for
  back-compat; `Status` now points here.
- [ADR-009](009-port-adapter-at-the-gateway.md) — made `ROUTING_KEYS` the fresh-write rule and
  deferred the call-site sweep to "a later focused cleanup pass"; that pass closes here.
- [ADR-046](046-libs-layout-and-dead-export-removal.md) — a deletion queued behind a condition,
  with no owner and no check, is forgotten.
- [ADR-050](050-the-alias-that-was-born-deprecated.md) — the nearest sibling: a back-compat alias
  kept for callers that had never needed it. Here the callers were real and are gone.
- [ADR-037](037-consent-record-and-tombstone-erasure.md) — `marketing.email.promo` as a template-registry
  key rather than a queue subject.
