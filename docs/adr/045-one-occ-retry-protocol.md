# ADR-045: One OCC retry protocol, not four copies of it

- **Date**: 2026-07-12
- **Status**: Accepted

---

## Context

[ADR-036](036-idempotency-key-store-and-enforced-occ.md) specifies a bounded optimistic-concurrency retry protocol: a lost compare-and-swap re-reads the aggregate and retries, up to `OCC_RETRY_ATTEMPTS`, logging each retry at `info` and the exhaustion at `warn`; anything that is **not** a lost CAS propagates immediately and is never retried.

It is implemented four times — inventory `stock` (`stock-mutation.ts`), retail `cart` (`cart-write.ts`), retail `orders` (`order-write.ts`), retail `returns` (`return-write.ts`). ADR-036 treats the per-module helper as a convention, so each copy reads as intentional rather than as drift.

The structural audit (`SYM-007`) flagged the four as one protocol written four times. They are — but not in the way the first reading assumed.

### What is actually shared, and what is not

The loops are structurally identical: `for 1..maxAttempts` → run the work → if the error is not this module's conflict type, rethrow → if the budget is spent, `warn` and throw the module's `*DomainException` → otherwise `info` and loop, with the same unreachable-tail guard.

The variation is real, though, and more than the audit's first sketch suggested:

| | conflict type | the attempt | retry-trace fields | exhaustion |
| --- | --- | --- | --- | --- |
| `stock` | 2 ids + `expectedVersion` | **wrapped in a transaction** | taken from the **conflict** | no `details` |
| `cart` / `orders` / `returns` | 1 id + `currentVersion` | a bare thunk | taken from the **context** | `{ currentVersion }` |

`stock` is the outlier on three axes at once: it opens a fresh transaction per attempt (the other three do their CAS inside `repository.save`), it takes the losing row's identity from the conflict rather than the caller's context (for a multi-row write, the loser is more precise than the context), and its terminal exception carries no version.

### Why the obvious generalisation is wrong

A naive shared loop — one that takes the work and pushes the logging back out to the caller — would have made the code **longer**. The duplicated `for`/`try`/`catch` is eight lines; the rest of each 80–180 line file is comments and module-specific logging and exception construction. Extracting eight lines behind a config object costs more than it saves.

That is the trap in reading `SYM-007` as a duplication problem. It is not one. **It is an invariant problem.**

## Decision

### 1. The core owns the loop, the levels, and the message texts

`libs/common/concurrency/occ-retry.ts` — `runWithOccRetry(attempt, policy)`. It owns exactly the things ADR-036 specifies and nothing else:

- the bounded loop and its budget;
- the rule that **only** a lost CAS retries;
- the log **levels** (`info` on retry, `warn` on exhaustion);
- both **message texts** (`"<Subject> write conflict — retrying with a fresh read"`, `"<Subject> write conflict exhausted retry budget"`), parameterised only by the subject — which is what keeps the trace greppable across services;
- the unreachable-tail guard.

The module supplies, as a `policy`: its conflict type guard, the extra fields for each of the two traces, and `onExhausted`. Those are the parts a lib cannot know — a lib has no business knowing that a lost stock CAS identifies its row by `(variantId, stockLocationId)` while a cart identifies its by `cartId`.

`onExhausted` returns **`never`**. That makes throwing a compile-time obligation: a policy that forgot to throw would otherwise fall out of the loop and return `undefined` **as if the write had succeeded** — reporting a lost write as a won one, the worst failure this loop has.

### 2. It lives in `libs/common/concurrency/`, beside `OCC_RETRY_ATTEMPTS`

The two halves of ADR-036 now sit together: `idempotency/` (the request-level fingerprint) and `concurrency/` (the retry budget token and the protocol). `application-use-case` may import `lib-common`, which is what makes the placement legal — the same check that decided ADR-043's token move.

The logger is a **structural** `IOccRetryLogger` (`info` / `warn`), not `PinoLogger`. `libs/common` is framework-free, and importing `nestjs-pino` to write two lines would end that. `PinoLogger` satisfies the shape, so every caller passes its own logger unchanged.

### 3. The four helpers stay — as bindings

`runWithStockWriteRetry` / `runWithCartWriteRetry` / `runWithOrderWriteRetry` / `runWithReturnWriteRetry` keep their names and signatures; nothing that calls them changed. Each is now a binding of the shared protocol to its module's types. `stock`'s is the only one that is not a plain delegation: it wraps the attempt in `transactionPort.runInTransaction`, so a retry re-reads under a fresh snapshot.

### 4. The protocol gets a test — for the first time

`libs/common/concurrency/spec/occ-retry.spec.ts`, seven cases: a winning write logs nothing; a conflict retries and the winner returns; **a non-conflict is never retried**; the budget bounds the attempts exactly (not budget + 1); `maxAttempts: 1` goes straight to exhaustion (the `If-Match` path); the levels and both message texts are pinned; and a policy that fails to throw surfaces as an error rather than a silent success.

Before this, none of those rules was asserted anywhere. They were only ever exercised incidentally, through whichever use-case spec happened to drive a conflict.

## Consequences

### Positive

- The protocol ADR-036 specifies is **single-source and provable**. Four hand-copies were four independent chances for the levels, the messages, or the only-conflict-retries rule to drift — and nothing would have caught it.
- A fifth aggregate gets the protocol right by construction; it cannot get it subtly wrong.
- `onExhausted: never` turns "you must throw here" from a comment into a compile error.
- The `If-Match` `maxAttempts: 1` path and the exact budget bound are now pinned by unit tests instead of living in prose.

### Negative

- **The code got longer, not shorter: 445 lines → 482** (four helpers 445 → 383, plus a 99-line lib). This is stated plainly because the opposite is the natural assumption about a de-duplication, and it is false here. The win is the invariant, not the byte count. A reviewer who wants a smaller diff should reject this ADR, not the measurement.
- One indirection: reading `cart-write.ts` no longer shows you the loop.
- Five policy fields is a lot of configuration surface. It is the price of not flattening away the genuine differences (§Context) — the alternative was a lib that lies about what the four modules do.

## Alternatives considered

- **Leave the four copies.** Defensible on line count, and ADR-036 already sanctioned it. Rejected because the thing being duplicated is a *rule*, not a utility: the levels and the retry policy are what ADR-036 exists to specify, and they were unenforced and untested in all four places.
- **A shared base `OccWriteConflictError` class**, with the loop catching the base. Rejected: it would let one module's loop retry another module's conflict, and the entire rule here is that a module retries only the write it made. The type guard keeps that exact.
- **Push the logging out to the caller** (the core takes only the work and an `isConflict`). This is the "obvious" generalisation, and it is the one that makes the code longer while enforcing nothing — the levels and messages would stay in four places.
- **Let the conflict error carry its own log fields** (`conflict.logFields`), removing two of the five policy hooks. Rejected: it would change the exhaustion trace's shape for `stock`, which takes its retry fields from the conflict but its exhaustion fields from the context. `test/concurrent-sweep-release.e2e-spec.ts` pins that trace.

---

## References

- [ADR-036](036-idempotency-key-store-and-enforced-occ.md) — the protocol this centralises; its per-module-helper convention is superseded by §3.
- [ADR-043](043-lifting-forced-duplicates-into-shared-libs.md) — the same "lift it into the lib the boundaries allow" move, and the `libs/common/concurrency/` folder this joins.
- [`docs/audits/audit-2026-07-12-structural-symmetry.md`](../audits/audit-2026-07-12-structural-symmetry.md) — `SYM-007`, the finding this closes.
