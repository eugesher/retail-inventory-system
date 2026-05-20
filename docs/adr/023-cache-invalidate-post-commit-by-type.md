# ADR-023: Post-commit cache invalidation enforced by the type system

- **Date**: 2026-05-20
- **Status**: Accepted

---

## Context

[ADR-002](002-redis-cache-aside-product-stock.md) established the
cache-aside contract for product-stock queries with one explicit
ordering rule: write paths invalidate the cache **after** the
transaction commits. Reading the cache pre-commit, or invalidating
pre-commit, races concurrent readers: they can re-populate the cache
from uncommitted state, and a subsequent rollback then leaves the
cache divergent from the database.

[ADR-016](016-cache-aside-generalized.md) §3 hardened this rule by
making the invalidate call `await`-ed rather than fire-and-forget, so
the confirm RPC's post-state must include "cache invalidated for the
mutated products". It did not, however, close the structural risk:
`IStockCachePort.invalidate(payload)` remained a public method, and
the "must run after the transaction commits" rule was enforced only
by a thirteen-line comment block above the call site in
`ReserveStockForOrderUseCase`. Nothing in the type system prevented a
future use case from calling `stockCache.invalidate(...)` inside an
`entityManager.transaction(async (em) => { ... })` callback.

The
[2026-05-20 follow-up audit](../audits/audit-2026-05-20-followup.md)
re-flagged this as **CACHE-002 — still-relevant**. The ADR-016 change
shifted the failure mode from "fire-and-forget runs early" to "awaited
call runs early" but did not move the contract into the type system.

This matters because the project will gain more aggregates that need
invalidate-on-write (retail orders next, future inventory aggregates
after that). Replicating a comment-enforced contract in every new
aggregate is a foot-gun multiplier. Replacing the comment with a
type-system contract fixes it once.

## Decision

Reshape `IStockCachePort` so that cache invalidation on write is
reachable **only** through a callback-based helper that intrinsically
orders the cache mutation after the work that produced it:

```ts
interface IStockCachePort {
  // ... get / set / getOrLoad as before
  withInvalidation<T>(
    work: () => Promise<T>,
    resolveItems: (result: T) => IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<T>;
}
```

The helper awaits `work()` first; on resolution it derives the
invalidation items from the work result and fires the internal prefix
delete; on rejection it rethrows without touching the cache.

`IStockCachePort.invalidate(...)` is **removed from the public port
surface**. The prefix-delete fan-out (the ADR-022 v1 + pre-v1 +
pre-ADR-016 transition-window wipes) lives on `StockCache` as a
private `invalidatePrefixes(items, opts)` method, reachable only from
inside `withInvalidation`. There is no public method left on the port
that can be called *without* a transaction reference.

### 1. Why a wrapper, not an `afterCommit` registry on the repository

Two designs were considered (the task brief named both):

- **Option A — `withInvalidation` wrapper on the cache port** (chosen).
- **Option B — `afterCommit(callback)` registry on
  `IStockRepositoryPort`.** The transaction callback receives a `tx`
  object with `tx.afterCommit(fn)`; the repository invokes registered
  callbacks after commit. The use case registers
  `() => stockCache.invalidate(...)` from inside the transaction.

Option A wins on three counts:

1. **Transactional concern stays out of `libs/cache`.** The generic
   `ICachePort` (`libs/cache`) has no notion of transactions today, and
   no aggregate other than stock needs one. Pushing an `afterCommit`
   hook onto `IStockRepositoryPort` would couple the repository
   surface to a cache-only concern that no other repository caller
   uses.
2. **Composes cleanly with the future `ITransactionPort`** (the
   eventual replacement for the `EntityManager` leak documented in
   [ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6 as
   ARCH-LINT-EX-01). The helper takes a `work: () => Promise<T>`
   callback — it knows nothing about TypeORM. When
   `entityManager.transaction(...)` is replaced by
   `transactionPort.run(work)`, the helper signature does not change:
   the use case wraps the new `transactionPort.run(...)` call inside
   `withInvalidation(...)` and the contract holds verbatim.
   Option B would have encoded the contract on the
   `IStockRepositoryPort.afterCommit` API, which the
   `ITransactionPort` refactor would then need to migrate again.
3. **The type signature carries the discovery → invalidate ordering.**
   `resolveItems(result: T)` takes the *resolved* `work` result. A
   misuse — deriving items before `work` runs — cannot be expressed.
   Option B's `tx.afterCommit(fn)` runs `fn` at an unspecified later
   point, which is still safer than the old surface but less precise
   in the type signature.

### 2. Implementation

`apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts`
declares the new method and replaces the public
`IStockCacheInvalidatePayload` type with an
`IStockWithInvalidationOptions` interface (tenant + correlationId).
`IStockCacheInvalidateItem` stays — `resolveItems` returns it.

`apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
implements `withInvalidation` by awaiting `work`, then conditionally
calling the private `invalidatePrefixes(items, opts)`. The
prefix-fan-out body (ADR-022 v1 + pre-v1 + pre-ADR-016 wipes) is
unchanged — only its visibility and entry point moved.

`ReserveStockForOrderUseCase` wraps its
`entityManager.transaction(async (em) => { ... })` call in
`stockCache.withInvalidation(work, resolveItems, { correlationId })`.
The `work` callback closes over an `acc: IStockAppendDeltaItem[]`
array that is mutated inside the transaction and returned to
`resolveItems` after `work` resolves. The thirteen-line
post-commit-ordering comment block at L122–L132 of the previous
implementation is gone — the rule is now encoded in the helper. The
`CODE-001` comment block about the unreachable `!!item.storageId`
filter is preserved, sitting next to the filter inside `resolveItems`.

### 3. Cache-aside contract preservation

The ADR-002 cache-aside contract is preserved verbatim:

- **Write path.** The write still runs first; cache invalidation
  follows. The helper's internals (`await work(); await
  invalidatePrefixes(items, opts);`) is exactly the same sequence the
  old `await ...transaction(); await stockCache.invalidate(...);`
  block produced — moved into one place that owns the ordering.
- **Read path.** Unchanged. `StockCache.get`, `set`, and `getOrLoad`
  keep their existing surfaces and behavior (including ADR-021
  single-flight + jitter).
- **Error handling.** `invalidatePrefixes` still swallows backend
  errors with a warn log (so a Redis-down event does not surface as a
  failed RPC). A rejected `work` propagates through `withInvalidation`
  unchanged, with no cache mutation.

### 4. Negative-path guarantee

If `work` rejects, `resolveItems` never runs and the prefix delete is
unreachable. The unit test
`reserve-stock-for-order.use-case.spec.ts` →
*"error-logs and rethrows when the transaction rejects, and does not
invalidate"* continues to pass under the new helper, and a parallel
test at the adapter level
(`stock.cache.spec.ts` → *"does not invoke the prefix delete when work
rejects"*) locks the contract in at the helper's own seam. A
companion test
(*"does not invoke invalidatePrefixes when work rejects after partial
appendDeltas"*) covers the harder case where the inner work has
already committed some side effects (the `appendDeltas` call) before
the transaction's commit step itself rejects — the helper still
correctly skips invalidation.

## Alternatives considered

- **Status quo + a stricter comment** (the path ADR-016 §3 took).
  Rejected: the comment is the same rule the audit re-flagged in
  CACHE-002. A second comment block does not address the structural
  risk.
- **Option B — `afterCommit` registry on `IStockRepositoryPort`.**
  Rejected on the three counts above: cross-cuts a generic repository
  surface with a cache-only concern, would need a rewrite when
  `ITransactionPort` lands, and leaves the discovery → invalidate
  ordering slightly less precise in the type signature.
- **Runtime guard inside `invalidate`** (throw a `DomainException` if
  called while a transaction is active on the same `EntityManager`).
  Rejected: only catches the foot-gun at runtime, depends on
  introspecting `EntityManager.queryRunner.isTransactionActive`, and
  the boundaries-lint rule for `application-port` denies the `typeorm`
  import that introspection needs. A type-system contract is strictly
  stronger.
- **Make `invalidate` package-private** (a TypeScript "module-private"
  via the
  [`@internal` JSDoc tag](https://www.typescriptlang.org/tsconfig#stripInternal)
  or by keeping the method off the exported interface but on the
  concrete class). Rejected: `@internal` is a comment, not an enforced
  visibility; off-interface methods are still callable through the
  concrete class injection that integration tests use (the
  `useExisting: StockCache` binding in `stock.module.ts`).

## Consequences

### Positive

- **The post-commit ordering is type-level, not comment-level.** A
  future contributor cannot mistakenly call `stockCache.invalidate(...)`
  inside `entityManager.transaction(async (em) => { ... })` — the
  method does not exist on the port. The compiler is the bumper.
- **The contract is reusable.** When the retail microservice adds a
  cache for the `orders` aggregate, the same shape applies: an
  `IOrderCachePort.withInvalidation(work, resolveItems, opts)` helper
  encodes the same rule with zero new comment blocks.
- **Composes cleanly with the future `ITransactionPort`** (ADR-017 §6
  ARCH-LINT-EX-01). The helper's `work: () => Promise<T>` callback is
  transaction-API-agnostic; the use case can swap
  `entityManager.transaction(...)` for `transactionPort.run(...)`
  without touching `IStockCachePort`.
- **Adapter tests get a sharper seam.** The
  `stock.cache.spec.ts` → `describe('withInvalidation')` block
  asserts ordering at the helper's own boundary
  (`work` → `resolveItems` → `delByPrefix`), independent of any
  surrounding use-case logic.

### Negative

- **Slightly more nesting at the call site.** The use case's
  transaction body now sits inside a `withInvalidation(async () => {
  ... }, (acc) => { ... }, { correlationId })` call. The reader pays
  one extra level of indentation in exchange for losing a 13-line
  comment block — net win on file length but a small readability cost
  for the call-site shape.
- **One adapter-level test had to change shape.** The previous
  `describe('invalidate')` block became `describe('withInvalidation')`
  with the same coverage plus three new tests for the ordering
  contract (work-before-prefix-delete, no-prefix-delete-on-rejection,
  no-prefix-delete-on-empty-items). Coverage is strictly broader.

### Open

- **`ITransactionPort` (ARCH-LINT-EX-01).** The
  `@nestjs/typeorm` + `EntityManager` seam in
  `ReserveStockForOrderUseCase` is still in place; the
  `withInvalidation` helper does not change it. The two suppressed
  imports tracked in ADR-017 §6 remain — the work to close that
  exception is independent of this ADR.

## References

- [ADR-002](002-redis-cache-aside-product-stock.md) — the cache-aside
  contract whose post-commit ordering rule this ADR moves into the
  type system.
- [ADR-016](016-cache-aside-generalized.md) — the centralised
  `delByPrefix` invalidation primitive that `withInvalidation` now
  delegates to internally.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6 —
  ARCH-LINT-EX-01, the `EntityManager` leak that the future
  `ITransactionPort` will close. The helper composes cleanly with that
  refactor.
- [ADR-022](022-cache-keys-tenant-and-schema-version.md) — the
  schema-version + tenant key segments that the private
  `invalidatePrefixes` still fans out across.
- [`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md)
  CACHE-002 — the still-relevant audit finding this ADR closes.
