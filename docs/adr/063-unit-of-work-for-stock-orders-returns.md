# ADR-063: Replace the cross-module `ITransactionScope` with a per-module Unit of Work in `stock`, `orders`, `returns`

- **Date**: 2026-09-24
- **Status**: Accepted — Option B, as proposed. §Open Questions resolved: (1) the runtime
  "closed after settle" guard is **deferred**, not built — see the note there; (2) Inspect &
  Disposition **keeps** its explicit shared-scope shape rather than being normalized to its
  siblings'; (3) confirmed — every single-aggregate write goes through the UoW; (4) the
  default migration order stands. The `libs/ddd` / `libs/database` runner and the `returns`
  module migration are **implemented** (the pilot from §Decision's migration plan); `stock`
  and `orders` remain.

---

## Context

[ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6 closed the `EntityManager` leak with `ITransactionPort`:
a use case asks the port to run its work, receives an opaque `ITransactionScope`, and passes that scope into
repository-port methods; only the infrastructure adapter un-opaques it
(`entityManagerOf`, [ADR-054](054-the-entity-manager-downcast-is-an-idiom.md)). [ADR-043](043-lifting-forced-duplicates-into-shared-libs.md)
lifted the port into `libs/ddd` and the adapter into `libs/database` after finding it copied byte-for-byte in
three modules. `TRANSACTION_PORT` is bound in exactly those three today (`grep -rn "provide: TRANSACTION_PORT" apps`):
inventory `stock`, retail `orders`, retail `returns`. Nowhere else.

Almost every method on almost every write-capable repository port in those three modules carries
`scope?: ITransactionScope` — **optional**, defaulting silently to the repository's own default-connection
manager when omitted. That optionality is the defect this ADR exists to close:

```ts
// Compiles today. Runs. The second write lands OUTSIDE the transaction the first one joined —
// a separate connection, a separate commit, nothing to roll back together.
await this.transactionPort.runInTransaction(async (scope) => {
  await this.orderRepository.save(order, scope);
  await this.paymentRepository.save(payment); // forgot `scope` — no error, no warning
});
```

Nothing catches this in review reliably (30+ call sites carry the parameter) and nothing catches it in a unit test
— the in-memory test doubles do not model connection isolation, so a forgotten scope is invisible until it
reaches a real transaction. [ADR-054](054-the-entity-manager-downcast-is-an-idiom.md) also names the second gap
plainly, under *Open*: the `unique symbol` brand proves a scope came from `TypeormTransactionAdapter.runInTransaction`,
never that it came from *this* invocation of it — a stale or cross-attempt scope passed to a repository would
type-check.

### Inventory — every transactional write site in the three modules

Verified against the current tree (`grep -rn "runInTransaction" apps`, cross-checked by reading every use case
below). Three columns matter beyond what runs inside the callback: whether an **RPC** is held open across the DB
transaction (the one deliberately-accepted case is Place Order, ADR-030), whether a **row lock**
(`...ForUpdate`) is taken, and what the **retry** shape is — stock opens a fresh transaction *inside* the OCC
loop (`runWithStockWriteRetry`); retail's three helpers (`runWithOrderWriteRetry` / `runWithReturnWriteRetry`)
take a bare thunk and the *caller* owns the `runInTransaction` inside it.

**inventory `stock`** — one shared shape everywhere: `stockCache.withInvalidation(() => runWithStockWriteRetry(deps, attempt, ctx), resolveItems, opts)`. `withInvalidation` stays *outside* the retry+transaction in every case (ADR-023); no stock use case holds an RPC open.

| Use case | Ports touched inside the scope | Row lock | Notes |
| --- | --- | --- | --- |
| Receive / Adjust (`applyOnHandChange`, shared by `receive-stock`/`adjust-stock`) | `STOCK_REPOSITORY.{findStockLevel,persistStockLevelChange}`, `STOCK_MOVEMENT_REPOSITORY.append` | no | one level, optional ledger row |
| Reserve | `STOCK_REPOSITORY`, `RESERVATION_REPOSITORY.{findByKey,save}` | no | idempotent-by-absolute-quantity |
| Release | `RESERVATION_REPOSITORY.{findById,save}`, `STOCK_REPOSITORY`, `STOCK_MOVEMENT_REPOSITORY.append` | no | all-lines-atomic, N rows |
| Allocate | `STOCK_REPOSITORY`, `RESERVATION_REPOSITORY.{findByKey,save}`, `STOCK_MOVEMENT_REPOSITORY.append` | no | all-lines-atomic, 3-phase (load/compute/write) |
| Cancel Allocation | `STOCK_REPOSITORY`, `STOCK_MOVEMENT_REPOSITORY.append` (keyed by caller's `operationKey`, ADR-057) | no | catches `isDuplicateEntryError` *outside* the retry — not a conflict, a replay |
| Commit Sale | `STOCK_MOVEMENT_REPOSITORY.existsByReference` (probe outside **and** re-probed inside the scope as phase 0), `STOCK_REPOSITORY`, `STOCK_MOVEMENT_REPOSITORY.append` | no | catches `LedgerReplayError`/dup outside the retry |
| Restock From Return | mirror of Commit Sale | no | inbound RPC from returns' Inspect (§below) |
| Transfer | `STOCK_REPOSITORY` ×2 (source+dest), `STOCK_MOVEMENT_REPOSITORY.append` ×2 | no | two levels, one attempt |
| Sweep Expired Reservations | `RESERVATION_REPOSITORY.findById`, `STOCK_REPOSITORY`, `STOCK_MOVEMENT_REPOSITORY.append` | no | **one `withInvalidation`/retry per chunk** — several `run()`s per invocation |
| Auto-Init Stock Level | `STOCK_REPOSITORY.saveStockLevel` | no | **no `TRANSACTION_PORT` at all** — a single first-touch insert, out of scope for the UoW |

**retail `orders`** — the least uniform module: three different transaction shapes coexist.

| Use case | Shape | Ports inside scope | RPC in-tx | Row lock | Retry |
| --- | --- | --- | --- | --- | --- |
| Place Order | **one big tx**: order.save → address.save ×2 → attachAddresses → cartReader.markConverted (CAS) → `inventory.allocateStock` | `ORDER_REPOSITORY`, `ADDRESS_REPOSITORY`, `ORDER_CART_READER.markConverted` | **yes — the allocate RPC, deliberately (ADR-030)** | no | none (CAS loss is terminal, not retried) |
| Place Order compensation (`compensateDeclinedAuthorization`) | separate small tx, single attempt | `ORDER_REPOSITORY.{findById,save}` | no (`cancelAllocation` RPC runs before it, outside) | no | none |
| Authorize Payment | one short tx after the out-of-process authorize call | `PAYMENT_REPOSITORY.save`, `ORDER_REPOSITORY.{findById,save}` (no `expectedVersion` — brand-new order, no concurrent writer yet) | no | no | none |
| Capture Payment | **three separate tx**: (1) claim under `FOR UPDATE`, commit; (2) release-on-decline, also locked; (3) complete-capture, OCC-retried | `PAYMENT_REPOSITORY.{findByOrderIdForUpdate,save}`, `ORDER_REPOSITORY.{findById,save}` | no — `paymentGateway.capture()` runs **between** tx (1) and tx (3), inside neither | **yes, in (1) and (2)** | only (3) wrapped in `runWithOrderWriteRetry` |
| Mark Delivered | one tx, OCC-retried | `FULFILLMENT_REPOSITORY.{findByIdForUpdate,save,listByOrderId}`, `ORDER_REPOSITORY.{findById,save}` | no | **yes** | `runWithOrderWriteRetry` |
| Issue Refund | `REFUND_REPOSITORY.save` (pending — **no scope**, own internal tx) → `paymentGateway.refund()` outside any tx → **one short tx** (payment.save + refund.save) *or*, on decline, `REFUND_REPOSITORY.save` (failed — **no scope**) | `REFUND_REPOSITORY`, `PAYMENT_REPOSITORY.save` | no | no | **no OCC retry loop at all** — reserve-first idempotency (`IDEMPOTENCY_STORE.reserve/finalize/release`) is the concurrency guard here, not OCC |
| Cancel Line | one tx, OCC-retried | `ORDER_REPOSITORY.{findById,save}`, `FULFILLMENT_REPOSITORY.listByOrderId` (read) | no (release RPC post-commit, `retryThenLogForReplay`) | no | `runWithOrderWriteRetry` |
| Cancel Order | one tx, OCC-retried | `ORDER_REPOSITORY.save`, `FULFILLMENT_REPOSITORY.{listByOrderId,findByIdForUpdate×N,save}`, `PAYMENT_REPOSITORY.{findByOrderIdForUpdate,save}` | no (release RPC post-commit) | **yes — N fulfillment locks + 1 payment lock** | `runWithOrderWriteRetry` |
| Ship Fulfillment | `captureIfNeeded`: two separate small tx (claim+commit; release-on-decline), both locked, **before** the main tx; **main tx**, OCC-retried: fulfillment lock+save, payment save (conditional), order save (CAS), fulfillment listByOrderId | `FULFILLMENT_REPOSITORY`, `PAYMENT_REPOSITORY`, `ORDER_REPOSITORY` | no (`commitSaleWithRetry` RPC post-commit) | **yes** (payment locks pre-main-tx; fulfillment lock in main tx) | `runWithOrderWriteRetry` on the main tx only |
| Create Fulfillment | **no explicit tx** — single `fulfillmentRepository.save(fulfillment)`, **no scope**, repo's own internal tx (root+lines, fresh insert) | `FULFILLMENT_REPOSITORY.save` | no | no | none |

**`IDEMPOTENCY_STORE.{save,reserve,finalize}` all carry an optional `scope` — and it is dead.** Every production
call site (`place-order`, `capture-payment`, `ship-fulfillment`, `issue-refund`) calls with **one** argument;
`grep -rn "idempotencyStore\.\(save\|reserve\|finalize\)("` across every use case confirms it. The parameter has
no caller passing it, ever — the ADR-049 finding, one level down.

**retail `returns`** — the smallest and most uniform module, and internally inconsistent in one place:

| Use case | Shape | Notes |
| --- | --- | --- |
| Open Return Request | single `repository.save(request)` — **no scope**, fresh insert, no OCC | |
| Authorize / Receive / Reject / Close Return (4 use cases) | `runWithReturnWriteRetry(..., async () => { const request = await loadReturnById(...); /* unscoped read */ request.<transition>(); return this.repository.save(request, undefined, versionAtLoad); })` | **read and write are not in the same transaction** — the read is a plain `findById`, the write is `save`'s own internal per-call tx. Sound because the write is a self-contained CAS; a stale read just loses the CAS and retries. |
| Inspect & Disposition | `runWithReturnWriteRetry(..., () => transactionPort.runInTransaction(async (scope) => { findById(rmaId, scope); ...; save(fresh, scope, versionAtLoad); }))` | **the one return use case that opens an explicit shared scope for what is still a single-aggregate write** — structurally could have used the four siblings' shape (nothing else joins the transaction). Not a correctness issue; a genuine shape asymmetry worth normalizing or explicitly keeping, decided in Alternatives/Open below. |

**What this inventory changes about the task's stated scope.** The cold-start brief's §4 snapshot (13 direct
`runInTransaction` call sites) undercounts the surface a "no transactional write outside a UoW" rule must cover:
five returns use cases, Create Fulfillment, and two `IssueRefund` writes never call `TRANSACTION_PORT` at all —
they write through the repository's own **implicit** per-call transaction (`OrderTypeormRepository.save` /
`ReturnRequestTypeormRepository.save` open `this.<repo>.manager.transaction(...)` internally when no scope is
given — the landmine `CLAUDE.md` already names). A design that removes `scope?` from every port method removes
that implicit fallback too, so these single-aggregate writes need *some* answer even though none of them touch a
second repository today. §Decision below treats this uniformly.

### Row-lock methods

`findByOrderIdForUpdate` (`IPaymentRepositoryPort`) and `findByIdForUpdate` (`IFulfillmentRepositoryPort`) already
require `scope: ITransactionScope` (non-optional) — the one place the current design already enforces
"transactional or nothing." They are called from: Capture Payment's claim/decline tx, Ship Fulfillment's
claim/decline tx and its main tx (fulfillment lock), Mark Delivered's main tx, Cancel Order's main tx (N
fulfillment locks + 1 payment lock). No stock or returns port has a locked read.

---

## Decision

**Adopt Option B — a generic `IUnitOfWorkRunner<TRepositories>` in `libs/ddd` + a generic TypeORM adapter in
`libs/database`, with each module declaring its own repository bag and binding its own write-repository classes.**

### Why B and not a bespoke UoW per module (Option A)

The runner's implementation does not vary by module — it is exactly `entityManager.transaction((m) => work(build(m)))`
in all three, the same way `TypeormTransactionAdapter.runInTransaction` was one byte-identical implementation
copied three times before [ADR-043](043-lifting-forced-duplicates-into-shared-libs.md) lifted it. ADR-043's own
argument (*"the seam is entirely domain-neutral... not by choice: cross-module isolation forbade sharing it"*)
applies verbatim to the runner half of a UoW. What is genuinely module-specific — which repositories compose the
bag, and how each is constructed from an `EntityManager` — stays in the module, exactly as ADR-045 kept each
module's conflict type and terminal exception local while lifting the shared retry loop. Duplicating the runner
three times would be inconsistent with a call this codebase has already made twice (ADR-043, ADR-045).

### The shape

```ts
// libs/ddd/unit-of-work.port.ts — framework-free, mirrors ITransactionPort's shape
export interface IUnitOfWorkRunner<TRepositories> {
  run<T>(work: (repos: TRepositories) => Promise<T>): Promise<T>;
}
```

```ts
// libs/database/typeorm-unit-of-work.adapter.ts — the one place a transaction opens
export class TypeormUnitOfWorkRunner<TRepositories> implements IUnitOfWorkRunner<TRepositories> {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly build: (manager: EntityManager) => TRepositories,
  ) {}

  public run<T>(work: (repos: TRepositories) => Promise<T>): Promise<T> {
    return this.entityManager.transaction((manager) => work(this.build(manager)));
  }
}
```

Per module (shown for `orders`; `stock` and `returns` are smaller instances of the same shape):

```ts
// orders/application/ports/orders-unit-of-work.port.ts — domain types only (lib-ddd/lib-contracts, as today)
export interface IOrdersUnitOfWork {
  readonly orders: IOrderWriteRepositoryPort;
  readonly payments: IPaymentWriteRepositoryPort;
  readonly fulfillments: IFulfillmentWriteRepositoryPort;
  readonly refunds: IRefundWriteRepositoryPort;
  readonly addresses: IAddressWriteRepositoryPort;
  readonly cartReader: IOrderCartConversionPort; // markConverted only
}
export const ORDERS_UNIT_OF_WORK = Symbol('ORDERS_UNIT_OF_WORK');
export type IOrdersUnitOfWorkRunner = IUnitOfWorkRunner<IOrdersUnitOfWork>;
```

```ts
// orders/infrastructure/persistence/orders-unit-of-work.adapter.ts
@Injectable()
export class OrdersUnitOfWorkAdapter implements IOrdersUnitOfWorkRunner {
  private readonly runner: TypeormUnitOfWorkRunner<IOrdersUnitOfWork>;

  constructor(@InjectEntityManager() entityManager: EntityManager) {
    this.runner = new TypeormUnitOfWorkRunner(entityManager, (manager) => ({
      orders: new OrderWriteRepository(manager),
      payments: new PaymentWriteRepository(manager),
      fulfillments: new FulfillmentWriteRepository(manager),
      refunds: new RefundWriteRepository(manager),
      addresses: new AddressWriteRepository(manager),
      cartReader: new CartConversionWriteAdapter(manager),
    }));
  }

  public run<T>(work: (uow: IOrdersUnitOfWork) => Promise<T>): Promise<T> {
    return this.runner.run(work);
  }
}
```

`IOrderWriteRepositoryPort` etc. are today's port interfaces **minus every `scope?` parameter** — the write
methods (`save`, `attachAddresses`, `findByIdForUpdate`, `findByOrderIdForUpdate`) move here; the
non-transactional reads (`findById` used as a plain post-commit re-read, `findBySourceCartId`, `listByCustomer`,
`listByOrderId`) **stay on the existing read port, injected directly, unchanged** — Place Order's
`this.orderRepository.findById(orderId)` after the transaction commits (line 409, re-read for the view) does not
become a UoW call; it was never transactional. Where a method serves both roles today (`findById(id, scope?)`,
used *inside* a retry attempt in some use cases and *outside* any transaction in others) it splits into two: a
plain `findById(id)` on the read port and a `findById(id)` with no scope parameter on the write bag — the caller
picks the port, not a parameter, and TypeScript picks the transaction for them.

The compiling-before / not-compiling-after example this buys:

```ts
// BEFORE — compiles, the payment write silently escapes the transaction.
await this.transactionPort.runInTransaction(async (scope) => {
  await this.orderRepository.save(order, scope);
  await this.paymentRepository.save(payment); // forgot `scope`
});

// AFTER — does not compile. `this.paymentRepository` is not an injected symbol;
// the only `payments.save` reachable at all is bound to `uow`, and it takes no scope to forget.
await this.ordersUow.run(async (uow) => {
  await uow.orders.save(order);
  await uow.payments.save(payment);
});
```

### Fitting the OCC protocols

- **stock** opens the transaction *inside* `runWithOccRetry`'s loop today
  (`runWithOccRetry(() => transactionPort.runInTransaction((scope) => attempt(scope)), policy)`). The UoW
  replacement is a straight substitution: `runWithOccRetry(() => stockUow.run((uow) => attempt(uow)), policy)`.
  `IStockWriteRetryDeps.transactionPort: ITransactionPort` becomes `unitOfWork: IStockUnitOfWorkRunner`; nothing
  about the loop, the levels, or the log text changes.
- **orders / returns** wrap a bare thunk that owns its own `runInTransaction` call
  (`runWithOrderWriteRetry(deps, () => this.transactionPort.runInTransaction(async (scope) => {...}), ctx)`).
  Same substitution: `() => this.ordersUow.run(async (uow) => {...})`.
- **`withInvalidation`** stays outside the retry+UoW call exactly as today — the wrapping order
  (`withInvalidation(() => runWithStockWriteRetry(...))`) is untouched, so ADR-023's post-commit-only invalidation
  invariant does not move.

### Fitting Place Order's held-open RPC and the claim-then-charge transactions

Place Order's shape is unchanged in kind: `ordersUow.run(async (uow) => { const persisted = await uow.orders.save(order); ...; await uow.cartReader.markConverted(cartId); ...; await this.inventory.allocateStock(...); ... })` —
the RPC still runs as the last statement inside the callback, holding the same transaction open across the same
in-cluster call, per ADR-030. Capture Payment's and Ship Fulfillment's claim/decline/complete shape is three
(or two) separate `run()` calls exactly where there are three (or two) separate `runInTransaction` calls today —
a UoW is scoped to one `run()`, not to a use case, so nothing about "the gateway call sits between two DB
transactions, holding no lock" changes.

### Row locks move from a required-scope parameter to a UoW-only method

`findByIdForUpdate` / `findByOrderIdForUpdate` had already tightened `scope` from optional to required — the
sole place today's design enforces "transactional or nothing." Under the UoW they tighten further: the method
does not exist on any injectable token outside `uow.payments` / `uow.fulfillments`, so "called outside a
transaction" is not a wrong argument anymore, it is a symbol that is not in scope.

### `IDEMPOTENCY_STORE`'s dead `scope` parameter is deleted, not migrated

No production call passes it (§Inventory). It is removed from `IIdempotencyStorePort.{save,reserve,finalize}`
outright — not folded into any UoW, because nothing ever needed it to join one.

### Single-aggregate writes go through the UoW too, for one reason: the fallback they rely on today disappears

Create Fulfillment, the four simple returns transitions, Open Return Request, and Issue Refund's two
`REFUND_REPOSITORY.save` calls all currently rely on `<Repo>.save`'s own `if (scope) { join } else { open my own
transaction }` branch. Removing `scope?` from the port removes that branch's `else` — there is no longer a
"repository opens its own transaction" fallback for the UoW-based repositories to fall back *to*. So every one of
these becomes `<module>Uow.run((uow) => uow.<aggregate>.save(...))`, a one-line callback. This is not spreading
the UoW to places that need cross-aggregate atomicity they didn't have before — none of these gain a second
repository in the bag — it is closing the exact fallback `CLAUDE.md`'s Landmines section already flags as a trap
(*"`OrderTypeormRepository.save` without scope at all opens its own transaction"*). After this change that
sentence is no longer true of any migrated repository, because there is no longer an unscoped path through it.

### The stale/leaked UoW question (ADR-054's *Open* item, revisited)

Neither this design nor `ITransactionScope` today can prove a handle came from *this* invocation rather than a
sibling one — the brand (or, here, the closure) proves origin, not currency. Two things are true regardless of
this ADR's decision: (1) a UoW's repositories close over a `QueryRunner`-bound `EntityManager` that TypeORM
releases back to the pool the moment `entityManager.transaction(...)` returns, so a call on a leaked `uow`
reference after `run()` settles fails at the driver — not silently, but with whatever error TypeORM's queryRunner
gives, not a clear domain message; (2) as ADR-054 already states about the current design, *"a scope is a
callback parameter and does not outlive its callback"* — no instance of this leak exists in the codebase today,
across either shape. An explicit runtime guard is a cheap addition — a shared `{ closed: boolean }` flag set
after `work()` settles, checked by each write-repository method before issuing a query, turning the failure into
a named `Error('unit of work used after its transaction settled')` instead of a raw driver error — and it directly
upgrades on the *Open* item rather than leaving it exactly where it was. It is listed as an owner decision in
§Open Questions rather than decided here, because it is pure addition (nothing in §Acceptance depends on it) and
the same "no instance exists, and none is likely" argument that kept ADR-054 from building one applies unchanged.

### Boundaries / lint impact

**No new lint edge.** `IUnitOfWorkRunner<TRepositories>` lives in `lib-ddd` (generic, no `typeorm`/`@nestjs/*` —
satisfies the existing denylist); `TypeormUnitOfWorkRunner` lives in `lib-database`, which already allows
`lib-ddd` ([ADR-043](043-lifting-forced-duplicates-into-shared-libs.md)). The two new per-module files
(`<module>-unit-of-work.port.ts` under `application/ports/`, `<module>-unit-of-work.adapter.ts` under
`infrastructure/persistence/`) match the *existing* `application-port` / `infrastructure` element patterns —
no new element type, no new `boundariesElements` entry, no new fixture required in
`spec/architecture-lint.spec.ts` for a rule that does not change. (A couple of fixtures pinning the new files
against the *existing* rules — e.g. that the UoW port cannot import `typeorm` — are cheap regression insurance,
not a taxonomy change, and are left to the implementer.)

### Test doubles

The three `spec/test-doubles.ts` files keep their `InMemory*Repository` classes and Map-backed logic verbatim —
only their method signatures lose the `scope` parameter (dead code today anyway; the fakes ignore it and share
one process-wide Map regardless). `FakeTransactionPort` / `CommitFailingTransactionPort` /
the snapshot-rollback fake become `FakeStockUnitOfWorkRunner` / `CommitFailingStockUnitOfWorkRunner` etc.,
wrapping the *same* in-memory repositories in the bag shape instead of threading `FAKE_SCOPE`. This is a smaller
rewrite than it sounds: today's fakes already simulate "the transaction" by calling `work(FAKE_SCOPE)` — the UoW
fakes call `work(fakeRepoBag)` instead, and the rollback/commit-failure semantics (snapshot-before, restore-on-throw;
run-to-completion-then-throw) move unchanged onto the new wrapper. `returns/spec/test-doubles.ts` (285 lines,
one aggregate) is the cheapest rewrite; `orders/spec/test-doubles.ts` (1105 lines, six port families) is the
largest and is where the read/write port split actually adds new surface (a read-only stub alongside the
UoW-bound write stub, where today one class satisfies one port).

### Migration plan

Module by module, each a separate PR/commit, in this order:

1. **`returns` — the pilot.** One aggregate, one write repository, six use cases — five of which do not even
   call `TRANSACTION_PORT` today. Proves the port/adapter shape, the doubles rewrite, and the
   `spec/port-method-callers.spec.ts` / `spec/architecture-lint.spec.ts` fallout cheaply before touching a
   harder module. Open Return Request and the four simple transitions become one-line `uow.run(...)` callbacks;
   Inspect & Disposition keeps its (already-correct, if slightly over-built) shape. Decide-and-record the
   Inspect-vs-siblings asymmetry noted above (§Open Questions) as part of this PR, since touching every return
   use case's transaction shape is exactly the moment to normalize or explicitly keep it.
2. **`stock` — the OCC-inside-loop shape.** Nine use cases share one retry/cache-invalidation wrapper
   (`runWithStockWriteRetry` inside `withInvalidation`), so the substitution is mechanical and uniform once the
   bag (`levels`, `reservations`, `movements`) and its adapter exist. Validates the "transaction opens inside the
   retry loop" substitution and the cache-invalidation-stays-outside invariant under real e2e load
   (`concurrent-oversell`, `concurrent-sweep-release`, `inventory-concurrency`) before the largest module.
3. **`orders` — last, and internally ordered by complexity.** Within the module: Create Fulfillment and
   Authorize Payment first (simplest — one short tx, no OCC, no row lock); Mark Delivered, Cancel Line next
   (one OCC-retried tx, at most one row lock); Issue Refund (mostly non-transactional; confirms the
   `IDEMPOTENCY_STORE` scope deletion); Cancel Order (multiple row locks in one tx); Capture Payment and Ship
   Fulfillment (the claim-then-charge multi-transaction shape, the two hardest non-Place use cases); **Place
   Order last** (the held-open RPC, the compensation transaction, and the largest single repository bag).

After all three modules are migrated: delete `ITransactionPort` / `ITransactionScope` / `TRANSACTION_PORT` /
`entityManagerOf` from `libs/ddd` and `libs/database`, and the `no-restricted-syntax` rule that exists only to
police inline `as EntityManager` casts against that scope type — a separate, final PR, not folded into the
`orders` migration, so a bisect of "did the UoW work" from "did removing the old seam work" stays clean.

---

## Alternatives Considered

### A — Unit of Work per module, no shared generic

Identical shape to §Decision, minus `IUnitOfWorkRunner<T>` / `TypeormUnitOfWorkRunner<T>`: each module declares
its own `run()`-shaped interface and its own adapter class whose `run` method is, verbatim,
`return this.entityManager.transaction((m) => work(this.build(m)))`. Scores identically to B on every substantive
question in this ADR — type-safety of "no write outside a UoW," OCC fit, Place Order fit, doubles cost, lint
impact (also zero new edges: the port would still live in `application/ports/`, importing only domain types, no
`lib-ddd` involvement at all). The only difference is that the three-times-identical runner body is duplicated
instead of shared. Rejected on the same grounds [ADR-043](043-lifting-forced-duplicates-into-shared-libs.md)
already used to lift `ITransactionPort` itself: *"the seam is entirely domain-neutral... not by choice: cross-module
isolation forbade sharing it."* That forcing function is gone once the runner lives in a lib both `lib-database`
and every module can reach — keeping it local anyway would be choosing to re-introduce the exact duplication
ADR-043 removed, for a mechanism no smaller than the one it removed. If the owner would rather not carry a
generic (one indirection layer, one more type parameter to read) over three call sites, A is the fallback with
no other cost — nothing else about the design changes.

### C — Minimal: keep `ITransactionScope`, make it required, split non-transactional reads onto separate ports

Change `scope?: ITransactionScope` to `scope: ITransactionScope` (no default) on every write method; move the
non-transactional reads (already a mixed bag on several ports) onto sibling read-only ports. This closes exactly
one of the three problems in §3 of the originating brief: a use case that forgets to pass `scope` now fails to
compile (a required parameter is missing), because TypeScript enforces arity. It closes nothing else:

- **Stale/leaked scope** — unchanged. `ITransactionScope` is still one nominal type; the compiler cannot tell a
  fresh scope from one captured three retries ago. Required-ness fixes "absent," not "wrong."
- **Signature noise** — unchanged, arguably worse. `scope: ITransactionScope` still threads through ~30 methods
  and every helper (`loadDistinctLevels`, `cancelOnce`, `allocateOnce`, `expireChunk`, …); splitting reads onto a
  second port *adds* a port per aggregate without removing the parameter from the one that keeps it.
- **Row locks** — already required today; C changes nothing about them.

This is the correct call for "smallest diff that fixes something," and it is honestly weaker on the design's
actual goal, which [ADR-054](054-the-entity-manager-downcast-is-an-idiom.md)'s own framing states as
`EntityManager` never reaching `application/` **and being inexpressible to call outside the transaction that
minted it** — C achieves the first (already true) and only half of the second (forgetting compiles-fails; a
stale handle still compiles-succeeds). Rejected as the destination; **noted as a legitimate low-risk interim
step** if the owner wants the "forgot to pass scope" class of bug closed before the larger UoW work lands, since
it is a mechanical, behavior-neutral diff (flip `?` to nothing, fix the resulting compile errors) that does not
block or conflict with migrating to B later.

### D — Ambient transaction via `AsyncLocalStorage`

Repositories read the active `EntityManager` from request/callback-local storage instead of receiving it as a
parameter at all; a `unitOfWork.run(fn)` (or a `@Transactional()` decorator, the `@nestjs-cls/transactional`
shape) populates the store for the duration of `fn`. This is the only alternative that removes signature noise
**entirely** — no `scope` parameter anywhere, ever — and it is rejected on the one criterion that matters most
here: **it does not make "wrote outside a transaction" inexpressible in types, because ALS state is not a type.**

```ts
// Compiles identically whether or not a transaction is active. The difference is a RUNTIME
// throw (or worse, a silent write to the default connection) that no type system catches.
await this.orderRepository.save(order);
```

The exact bug this ADR exists to close — a call that should have joined a transaction and silently did not —
becomes, under D, a bug that no longer needs a missing argument to happen; it needs only a call site outside the
right dynamic extent, which is precisely the class of error ALS is known for losing across `Promise.all` fan-outs,
detached callbacks, and library code that doesn't propagate context faithfully. Several use cases in this
codebase fan out post-commit emits via `Promise.all` (Reserve, Release, Allocate, Ship, …) specifically *outside*
the transaction — under ALS, keeping those calls from *accidentally* inheriting a settled or wrong context becomes
a discipline the codebase would have to maintain by convention, the same convention this whole ADR exists to stop
relying on. Doubles also get harder, not easier: a fake ALS context must be set up and torn down per test with
enough discipline that one test's context cannot leak into the next (a documented ALS/Jest hazard), replacing a
constructor-injected fake with a global mutable one. Rejected; not attempted further.

---

## Consequences

### Positive

- **"Forgot to pass the scope" is not a category of bug that can exist in the migrated modules** — the type that
  would have to be passed does not appear anywhere outside `uow.run(...)`'s callback parameter.
- **Row-locked reads (`...ForUpdate`) become reachable only through a UoW**, closing the one place the current
  design already wanted "transactional or nothing" but could only ask for with a required-but-forgeable parameter.
- **Five returns use cases, Create Fulfillment, and two Issue Refund writes stop relying on the repository's own
  implicit per-call transaction** — a fallback this migration removes outright rather than leaves as a second,
  UoW-adjacent way to write.
- **`IDEMPOTENCY_STORE`'s dead `scope` parameter is deleted**, not carried forward into a UoW it never needed.
- **No new lint edge, no new element type** — the taxonomy `eslint-plugin-boundaries` already enforces reaches
  every new file this design adds.
- **The shared runner is a genuine lift, not a premature one** — its body is identical across all three modules
  today in the exact sense ADR-043 already used to justify lifting `ITransactionPort`.

### Negative

- **The migration footprint is larger than the brief's own snapshot suggested** — five returns use cases and
  Create Fulfillment gain a `uow.run(...)` wrapper they did not need to have called `TRANSACTION_PORT` for
  before, purely because the scope-less fallback they relied on is what this design removes.
- **`orders`' three-tier retry/lock/RPC choreography (Capture, Ship) does not get simpler** — the UoW changes
  what a transactional write looks like, not how many separate transactions Capture Payment or Ship Fulfillment
  need; that shape (claim → out-of-process call → complete) is unrelated to this ADR and stays exactly as
  complex.
- **One more generic type parameter to read** (`IUnitOfWorkRunner<TRepositories>`) versus a bespoke interface per
  module — a real, if small, cost for a reader meeting the pattern for the first time. Option A removes this at
  the cost of reintroducing the duplication ADR-043 already argued against once.
- **`orders/application/use-cases/spec/test-doubles.ts` (1105 lines) is the single largest file this migration
  touches**, and the read/write port split adds a second stub class per aggregate where one sufficed before.

---

## Open Questions — resolved

Approved by the owner as "Option B, by default": the structural decision and the migration order stand as
proposed; the three sub-questions resolve as follows.

1. **The runtime "closed after settle" guard on a leaked UoW reference — deferred, not built.** Adding it is not
   free: `TypeormUnitOfWorkRunner<TRepositories>` is generic and knows nothing about the shape of the module's
   write-repository classes, so the guard would need a shared mutable session object threaded into every
   write-repository's constructor and checked at the top of every one of its methods — real surface across all
   three modules' write repositories by the time `stock` and `orders` are done, not a one-line addition. The
   `returns` migration ships at parity with the pre-UoW design instead: `ReturnRequestWriteTypeormRepository`
   closes over a plain `EntityManager`, and a call after its transaction has settled fails at the TypeORM/driver
   level (the queryRunner is released back to the pool) rather than with a named domain error. No instance of this
   leak exists in the codebase in either shape (ADR-054's own reasoning, unchanged). Revisit if `stock` or `orders`
   turns up a real near-miss; until then this stays a documented, not implemented, upgrade.
2. **The Inspect & Disposition vs. its four sibling returns use cases asymmetry — kept, not normalized.**
   `InspectAndDispositionUseCase` still opens one `returnsUow.run(...)` wrapping both the re-read and the write;
   Authorize/Reject/Receive/Close still read unscoped and write through a separate `returnsUow.run(...)` call. The
   lower-risk, purely-mechanical migration was preferred over a behavior-shape cleanup riding along with it —
   both `apps/retail-microservice/src/modules/returns/application/use-cases/inspect-and-disposition.use-case.ts`
   and its four siblings carry a comment cross-referencing this decision.
3. **Widening the five single-aggregate-write additions beyond a one-line `uow.run(...)` — confirmed no.** Open
   Return Request, the four simple transitions, and (in a later module) Create Fulfillment and Issue Refund's two
   `REFUND_REPOSITORY.save` calls each become exactly one `<module>Uow.run((uow) => uow.<aggregate>.save(...))`
   callback, implemented for `returns` in this pass. Issue Refund's pending-save-before-the-gateway-call durability
   property (ADR-036) is untouched — it lands with the `orders` migration, unchanged in shape.
4. **Migration order confirmed**: `returns` (this pass) → `stock` → `orders`, Place Order last within `orders`.

### What shipped in this pass

`libs/ddd/unit-of-work.port.ts` (`IUnitOfWorkRunner<TRepositories>`) and
`libs/database/typeorm-unit-of-work.adapter.ts` (`TypeormUnitOfWorkRunner<TRepositories>`) — the shared halves — and
the full `returns` module migration: `IReturnRequestRepositoryPort` trimmed to the two non-transactional reads;
the new `IReturnRequestWriteRepositoryPort` / `IReturnsUnitOfWork` / `RETURNS_UNIT_OF_WORK` in
`application/ports/`; `ReturnRequestTypeormRepository` trimmed to the read side;
`ReturnRequestWriteTypeormRepository` (new, unregistered with Nest — reachable only via the UoW) carrying the
former `save`/`persistGraph`/`persistRoot`/`persistLines` verbatim; `ReturnsUnitOfWorkAdapter` (new) binding
`RETURNS_UNIT_OF_WORK`; all six use cases updated; `TypeormTransactionAdapter`/`TRANSACTION_PORT` un-bound from
`returns.module.ts` (nothing in the module needs them anymore). Verified: `yarn lint --max-warnings 0` clean, `tsc
--noEmit` clean on all six services, `yarn build:retail-microservice` clean,
`spec/architecture-lint.spec.ts` / `spec/port-method-callers.spec.ts` / `spec/transition-windows.spec.ts` green
with no rule changes, full `yarn test:unit` green (206 suites / 1970 tests), and the `return-restock-refund` /
`return-rejected` e2e suites green against a real MySQL instance.

---

## References

- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6 — introduced `ITransactionPort` / `ITransactionScope`,
  closing the prior `EntityManager` leak this ADR's UoW replaces the seam of.
- [ADR-043](043-lifting-forced-duplicates-into-shared-libs.md) — lifted the byte-identical transaction seam into
  `libs/ddd` + `libs/database`; the precedent this ADR's Option B follows for the UoW runner.
- [ADR-045](045-one-occ-retry-protocol.md) — the shared-core/module-specific-policy split this ADR mirrors for
  the UoW (shared runner, module-owned repository bag).
- [ADR-054](054-the-entity-manager-downcast-is-an-idiom.md) — names the *Open* stale/leaked-scope gap this ADR's
  optional runtime guard (§Open Questions) would close; the downcast idiom itself (`entityManagerOf`) is retired
  alongside `ITransactionScope` once all three modules are migrated.
- [ADR-023](023-cache-invalidate-post-commit-by-type.md) — the post-commit-only cache invalidation ordering that
  `withInvalidation` preserves unchanged around the UoW-based retry.
- [ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) — the deliberately-held-open `allocateStock`
  RPC inside Place Order's transaction, unchanged in kind under the UoW.
- [ADR-036](036-idempotency-key-store-and-enforced-occ.md) — the OCC retry protocol and the idempotency-key store
  whose dead `scope` parameter this ADR deletes.
- [ADR-049](049-the-port-methods-nothing-calls.md) — the precedent for deleting a port parameter/method with no
  production caller rather than carrying it forward.
- [ADR-057](057-cancel-allocation-needs-an-operation-identity.md) — Cancel Allocation's `operationKey`-keyed ledger
  dedupe, caught outside the OCC retry exactly as it is today; unaffected by the UoW substitution.
