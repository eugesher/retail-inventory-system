# ADR-056: Lifting the post-commit retry helper, and the test that decides what may be lifted

- **Date**: 2026-07-24
- **Status**: Accepted

---

## Context

[ADR-043](043-lifting-forced-duplicates-into-shared-libs.md) lifted two forced duplicates into the
shared libs — the transaction seam into `libs/ddd` + `libs/database`, and `OCC_RETRY_ATTEMPTS` into
`libs/common/concurrency/` — on a diagnosis it stated plainly:

> *when an isolation rule forces you to duplicate code in order to obey it, the thing that is
> usually wrong is not the rule but the placement.*

It also named a third duplicate, and did **not** lift it. From its Alternatives:

> *The `retry-then-log-for-replay.ts` precedent (duplicated in `orders` and `returns` because
> returns may not import orders) shows the project accepts a duplicate **when the alternative is a
> broken boundary**.*

That sentence is the problem. For this file the alternative is **not** a broken boundary.
`retryThenLogForReplay` was 30 lines whose only import was `PinoLogger`; it named no domain type,
no port, no transport. Lifting it into `libs/common` breaks exactly as much as lifting
`OCC_RETRY_ATTEMPTS` did — nothing. The two duplicates had the same cause, the same target lib, and
opposite outcomes, and the record gave no reason for the asymmetry beyond citing the un-lifted one
as evidence that duplicates are sometimes accepted.

So the duplicate stood on a justification that does not describe it. That is the shape ADR-046
named — *a decision queued behind a condition, with no owner and no check* — and nothing enforced
it either way: no entry in `spec/transition-windows.spec.ts`, no lint rule, nothing that would
notice the two copies drifting.

### They had not drifted, and that was luck

At the time of this decision the two copies' executable code was byte-identical. Only their comments
differed, and deliberately — each named its own module's operations. But the marker was **one-
directional**: the `returns` copy said it was a deliberate copy of the `orders` original; the
`orders` original said nothing about having a twin. Someone editing the original had no signal that
a second file existed. They stayed in sync because one sweep (the ADR-052/ADR-032 comment
reconciliation) happened to touch both files at once.

## Decision

### 1. `retryThenLogForReplay` moves to `libs/common/resilience/`

Beside `concurrency/` and `idempotency/`. Both module copies are deleted; the three call sites —
`ship-fulfillment.use-case.ts`, `cancel-allocation-retry.ts`, `inspect-and-disposition.use-case.ts`
— import it from `@retail-inventory-system/common`.

The lib choice is decided by the taxonomy, exactly as ADR-043 §3 decided it for
`OCC_RETRY_ATTEMPTS`: `application-use-case` **may** import `lib-common`, and every consumer is a
use case. No new lint edge is needed and none is added.

### 2. The logger becomes structural, not `PinoLogger`

`libs/common` is framework-free and importing `nestjs-pino` would end that. The lifted helper
declares `IRetryThenLogLogger` — `warn` and `error`, the two methods it calls — which `PinoLogger`
satisfies structurally, so every call site passes its own logger unchanged. This is `IOccRetryLogger`
one folder over ([ADR-045](045-one-occ-retry-protocol.md)), and it is why the lift is not a
copy-paste.

### 3. The test for what may be lifted: **does the signature name a module-owned type?**

This is the part worth keeping, because "it is duplicated" is not by itself a reason to lift
anything.

- `retryThenLogForReplay` took a thunk, a number, a string, a `Record<string, unknown>` and a
  logger. **No module type.** A lib can hold it.
- `resolveCustomerEmail` takes `IReturnCustomerContactReaderPort`. **A port is the module's type.**
- `ReturnWriteConflictError` carries `rmaId`. Erasing that field to share the class would remove
  the thing that makes its trace useful.
- `IReturnWriteRetryDeps` is the module's half of an OCC protocol whose *invariant core* was
  already lifted (ADR-045). What remains is the conflict type and the terminal exception — both
  module-owned.

So the returns module keeps four deliberate copies and loses one. That is not an inconsistency; it
is the rule applied. The four comments that cited `retry-then-log-for-replay` as their
per-module-copy precedent are corrected in this change to cite the rule instead — a precedent that
has been lifted is a counter-example, and leaving those citations would have taught the opposite of
what happened.

## Alternatives Considered

- **Leave both copies and make the marker bidirectional** (add "this file has a twin in `returns/`"
  to the orders original). Rejected as the *whole* answer, though it was the cheap half: it makes
  drift noticeable to a careful reader and does nothing about the drift itself. The comment is a
  request; the lib is a guarantee. It is the same trade ADR-049 made about port methods with no
  caller — *it is a script, run when someone thinks to run it.*
- **Lift it into `libs/ddd`.** Rejected: `lib-ddd` is the domain-facing contract kernel, and a retry
  loop is neither a domain concept nor a port. `libs/common` already holds the sibling protocol.
- **Generalise `IOccRetryLogger` into one shared structured-logger type and have both protocols use
  it.** Rejected for now, and deliberately: the two protocols need different methods (`info`/`warn`
  vs `warn`/`error`), and merging them would widen each to the union for no caller's benefit. Two
  three-line interfaces are cheaper than one that over-promises.
- **Do nothing, on the grounds that two consumers do not pay for a lib.** Rejected: the cost of the
  lib is one folder and one export line, and the cost of the duplicate is that it already carried a
  one-directional marker and a justification that did not describe it. The count of consumers is not
  what makes this wrong.

## Consequences

### Positive

- One post-commit retry posture in one file, for all three cross-service calls the retail service
  makes after its own transaction commits.
- The lifted comment can finally say something the copies could not: it carries a table of *what
  makes a redelivery safe per operation*, because it now sees all three call sites. That table is
  what surfaced the asymmetry [ADR-057](057-cancel-allocation-needs-an-operation-identity.md)
  addresses.
- A stated test for the next forced duplicate, instead of a precedent that had to be read as
  permission.

### Negative

- One more thing in `libs/common`, which grows by concern rather than by plan. `resilience/` is now
  a third sibling to `concurrency/` and `idempotency/`; a fourth would be worth pausing over.
- The per-module comment specificity is genuinely lost — the `orders` copy explained what awaiting
  replay cost *for its two operations*, the `returns` copy for *its one*. The lifted file states the
  general posture and defers the per-operation cost to each call site's `replayMessage`, which is
  where it was always written anyway.

### Neutral

- ADR-043 is **not** superseded. Its three decisions stand untouched; this ADR corrects one sentence
  of its reasoning in a place ADR-003 permits — a new record, not an edit to an accepted one.

## References

- [ADR-043](043-lifting-forced-duplicates-into-shared-libs.md) — the two lifts this completes, and
  the Alternatives sentence this record revisits.
- [ADR-045](045-one-occ-retry-protocol.md) — `runWithOccRetry` and the `IOccRetryLogger` structural-
  logger idiom this reuses.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the boundaries taxonomy that makes
  `lib-common` reachable from `application-use-case` and forbids the cross-module import that forced
  the duplicate.
- [ADR-049](049-the-port-methods-nothing-calls.md) — the same posture about a symbol whose stated
  justification no longer describes it.
- [ADR-057](057-cancel-allocation-needs-an-operation-identity.md) — found while writing the lifted
  file's comment, because one file could finally see all three callers at once.
