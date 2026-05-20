# fix — post-commit invalidate contract enforced by types

> Paste this entire file as the first user message in a Claude Code (Opus)
> session opened at the project root of `retail-inventory-system`. Do not
> add anything else.

## Conventions

This task inherits the rules in
[`docs/tasks/CONVENTIONS.md`](CONVENTIONS.md). Read it before starting.

## Context

- Source audit: [`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md)
- Issue addressed: **CACHE-002**
- Original audit (historical): [`docs/audits/audit-2026-05-08.md`](../audits/audit-2026-05-08.md)
- Relevant ADRs: [ADR-002](../adr/002-redis-cache-aside-product-stock.md),
  [ADR-016](../adr/016-cache-aside-generalized.md)

`IStockCachePort.invalidate(payload)` is a public method
(`apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts`
L35) and the "must run after the transaction commits" rule is enforced
only by a comment block in
`apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts`
L122–L132. Nothing in the type system prevents a future use case from
calling `stockCache.invalidate(...)` inside an `entityManager.transaction(...)`
callback. Calling it pre-commit would race with concurrent readers:
they could re-populate the cache from uncommitted state and then the
writer's transaction could roll back, leaving the cache divergent from
the DB.

The migration's awaiting-the-invalidate change (ADR-016 §3) made the
comment *more* prominent but didn't fix the structural risk — it merely
shifted the failure mode from "fire-and-forget runs early" to "awaited
call runs early".

Why it matters: the project will gain more aggregates that need
invalidate-on-write (retail orders, future inventory aggregates).
Replicating the comment-enforced contract in every new aggregate is a
foot-gun multiplier. Replacing the comment with a type-system contract
fixes it once.

## Goal

`IStockCachePort.invalidate` is no longer directly callable from a
context that may be inside a transaction. The post-commit ordering is
enforced by the type system — either through an `addAndInvalidate`
helper that takes the transaction work and the invalidate work as a
pair and orders them itself, or through an `afterCommit` callback
registry on the repository port that fires invalidates after the outer
transaction has committed. Either design is acceptable; the choice is
documented in an ADR.

## Acceptance criteria

- [ ] A future code change that calls `stockCache.invalidate(...)`
      from inside `entityManager.transaction(async (em) => { ... })`
      either:
      - is a type error (preferred — direct call site is gone), OR
      - is caught at runtime by a `DomainException` thrown from the
        cache adapter when called while a transaction is active on the
        same `EntityManager`.
- [ ] `ReserveStockForOrderUseCase` no longer contains the multi-line
      explanatory comment about post-commit ordering — the rule is now
      encoded in the helper / callback registry it depends on. (The
      `CODE-001` comment block about the `!!item.storageId` filter
      stays put — that's a different annotation.)
- [ ] The existing unit test "error-logs and rethrows when the
      transaction rejects, and does not invalidate" continues to pass
      under the new design.
- [ ] At least one new unit test exercises the new contract directly
      — e.g. asserts that the helper invokes the invalidate work
      after the transaction callback resolves, and does **not** invoke
      it when the transaction rejects.
- [ ] No public method named `invalidate` remains on the stock cache
      port surface that can be called *without* a transaction
      reference. If the chosen design keeps `invalidate` public for
      use by non-mutating callers (cache warmers, admin tooling),
      rename it (`invalidateOutsideTransaction`) so the foot-gun is
      hard to fall into by accident.

## Files likely involved

- `apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts`
  — likely shape change: new method like `withInvalidation<T>(items, work: () => Promise<T>): Promise<T>`
  that wraps `work` and runs `delByPrefix` after `work` resolves.
- `apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts`
  — alternative: an `afterCommit(callback)` hook registered inside the
  transaction callback that the repository invokes after commit. Look
  at ARCH-LINT-EX-01 in ADR-017 §6 first — the EntityManager leak that
  task closes intersects with the design choice here.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
  — implementation of the new method on `StockCache`.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts`
  — call-site rewrite. The transaction body and the invalidate
  arguments are co-located now; the helper should let them stay co-located.
- Specs: `reserve-stock-for-order.use-case.spec.ts`, `stock.cache.spec.ts`.

## Steps

1. Pick a design. Two reasonable options:

   **Option A — `withInvalidation` wrapper on the cache port.** Shape:
   ```ts
   withInvalidation<T>(
     items: IStockCacheInvalidateItem[],
     correlationId: string | undefined,
     work: () => Promise<T>,
   ): Promise<T>;
   ```
   The wrapper awaits `work()`, captures items as derived from the result
   of `work` (or supplied up-front), and runs `delByPrefix` only on
   `work` resolving successfully. The use case calls `withInvalidation`
   *around* the `entityManager.transaction(...)` block. `invalidate` is
   removed from the public port surface.

   **Option B — `afterCommit` registry on `IStockRepositoryPort`.** The
   transaction callback receives a `tx` object with `tx.afterCommit(fn)`.
   The repository invokes registered callbacks after the outer transaction
   commits. The use case registers `() => stockCache.invalidate(...)`
   from inside the transaction. `invalidate` stays public on the cache
   port but is now only reachable via the post-commit callback path.

   Option A pushes the contract onto the cache port; Option B pushes it
   onto the repository port. Option A is simpler and keeps the
   transactional concern out of `libs/cache` (which has no notion of
   transactions today). Recommend Option A unless ARCH-LINT-EX-01's
   eventual `ITransactionPort` lands first.

2. Read ADR-017 §6 ARCH-LINT-EX-01 about the `EntityManager` leak.
   The eventual `ITransactionPort` will reshape this seam; design the
   helper so it composes cleanly with that future port (Option A
   does — Option B may need a rewrite when `ITransactionPort` lands).

3. Implement the chosen design. Keep the implementation in the
   inventory-microservice (no new cross-service abstraction) — this
   isn't ripe for promotion to `libs/cache` until a second aggregate
   needs the same pattern.

4. Rewire `ReserveStockForOrderUseCase` through the helper. Delete the
   `// Post-commit:` comment block at L122–L132. Keep the `CODE-001`
   comment block at L134–L149 (it documents the unrelated filter).

5. Update specs:
   - `reserve-stock-for-order.use-case.spec.ts` — adjust the existing
     "transaction rejects → does not invalidate" assertion to the new
     code path; add a positive-path assertion that the invalidate
     runs after the transaction's `appendDeltas` call completes.
   - `stock.cache.spec.ts` — if the public surface changed, drop
     direct-`invalidate` tests for the deprecated method and add
     direct-`withInvalidation` tests.

6. Run the verification gate.

## Documentation updates required

- [ ] **ADR required.** Create `docs/adr/<NNNN>-<slug>.md` documenting:
      - the option chosen and why,
      - how it composes with the future `ITransactionPort`
        (ARCH-LINT-EX-01 in ADR-017),
      - that ADR-002's cache-aside post-commit contract is preserved.
- [ ] Update `docs/adr/index.md`.
- [ ] Update `CLAUDE.md` "Service Structure → Microservices" if the
      port surface name in the docstring changed (the bullet that
      lists `IStockCachePort` and reads "fans `delByPrefix` per unique
      productId" may need adjusting).
- [ ] No `README.md` update required (internal contract); record the
      reason in carryover.

## Verification

- [ ] `yarn install` succeeds
- [ ] `yarn build` succeeds
- [ ] `yarn lint` succeeds (max-warnings 0)
- [ ] `yarn test:unit` succeeds
- [ ] The "transaction rejects → does not invalidate" test still passes
- [ ] At least one new positive-path test asserts the helper runs
      invalidate after the transaction work, and not before

## Carryover

Write `_fix-cache-invalidate-contract-summary.md` with:

- Design chosen (Option A or B, with the rationale link to the ADR)
- Files edited
- Tests added/updated
- ADR created (path + decision summary)
- Documentation updates
- Verification results
- Anything unexpected — surface for human review
