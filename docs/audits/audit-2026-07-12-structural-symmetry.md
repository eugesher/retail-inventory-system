---
date: 2026-07-12
status: open
---

# Audit Report — 2026-07-12 — Structural symmetry across the six services

## Summary

A structural sweep of all six deployables, run after the module-layout work
([ADR-041](../adr/041-nest-module-as-the-module-composition-root.md),
[ADR-042](../adr/042-one-bounded-context-one-module.md)), comparing every module on the axes a
reader would expect to be uniform: layer folders, entity registration, exceptions, filters,
file naming, DI tokens, shared helpers, bootstrap shape.

Seven findings. Four are fixed; three remain open.

| Code | Finding | Status |
|------|---------|--------|
| `SYM-001` | Transaction seam duplicated in three modules | **fixed** (ADR-043) |
| `SYM-002` | `OCC_RETRY_ATTEMPTS` token duplicated in four modules | **fixed** (ADR-043) |
| `SYM-003` | `MessagingModule` dead — one importer, and it injected nothing | **fixed** (ADR-043) |
| `SYM-004` | The `ClientProxy` filename rule in the docs did not match the code | **fixed** (2026-07-12) |
| `SYM-005` | Exception-file and RPC-filter naming drift | open |
| `SYM-006` | Functional asymmetries (health surface, gateway admin shells) | open |
| `SYM-007` | The four `runWith<X>WriteRetry` helpers are one protocol, written four times | open |

### What SYM-001 and SYM-002 had in common

Two of them (`SYM-001`, `SYM-002`) were the *same* defect: a thing that is not module-specific,
copied into every module that needs it, because cross-module isolation leaves no legal way to
share it and nobody lifted it into a lib. This is the diagnosis ADR-042 made inside the event
store, one level up: **when an isolation rule forces you to duplicate code in order to obey it,
what is usually misplaced is the code, not the rule.** `SYM-007` is the same shape again, but it
needs a design decision rather than a move — see below.

---

## `SYM-004` — the `ClientProxy` filename rule did not match the code — **FIXED**

**Resolution (2026-07-12).** The containment rule is now **enforced in CI** rather than reviewed: a
`no-restricted-imports` entry scoped to `apps/**` (ignoring `infrastructure/messaging/**`) with
`importNames: ['ClientProxy', 'ClientProxyFactory', 'ClientsModule']`. `eslint-plugin-boundaries`
cannot express this — it types elements by path, and `@nestjs/microservices` is legitimately
imported outside `messaging/` for `@EventPattern` / `@MessagePattern` / `Transport`. `importNames`
names the one symbol that must stay contained. Zero violations existed, so the rule went in green.

The filename half of the old rule was **wrong, not the code**: the dot form is correct and mirrors
the port it implements. The docs now state both forms. The three `rmq-*` outliers — a *third*
scheme — were renamed to the established ones (`customer-events.rabbitmq.publisher.ts`,
`audit-log.rabbitmq.publisher.ts` ×2; classes `Rmq<X>Publisher` → `<X>RabbitmqPublisher`), so two
conventions remain instead of three.

### Original finding

`CLAUDE.md` and `README.md` §3 both state:

> `ClientProxy` from `@nestjs/microservices` is allowed *only* inside
> `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`.

**The containment half is true**: all 21 files that import `ClientProxy` live in
`infrastructure/messaging/`. **The filename half is not**: 7 of the 21 do not match the glob.

- **Six** cross-service adapters use a **dot**, not a hyphen, before `rabbitmq`:
  `cart-catalog.rabbitmq.adapter.ts`, `cart-inventory.rabbitmq.adapter.ts`,
  `order-catalog.rabbitmq.adapter.ts`, `order-commit-sale.rabbitmq.adapter.ts`,
  `order-inventory.rabbitmq.adapter.ts`, `inventory-restock.rabbitmq.adapter.ts`.
  These are internally coherent and their **ports use the same dot**
  (`cart-catalog.gateway.port.ts`) — the dot separates a two-word seam name from the
  `rabbitmq.adapter` suffix, avoiding `cart-catalog-rabbitmq.adapter.ts`. So there are really
  *two* conventions, and the docs describe one.
- **One** uses a prefix: `rmq-customer-events.publisher.ts` (gateway `auth`). Its sibling
  `rmq-audit-log.publisher.ts` exists twice (gateway `auth`, retail `orders`) and lives under
  `infrastructure/audit/` rather than `messaging/` — those two hold no `ClientProxy`, so they
  are outside the rule, but they are the same naming outlier.

The rule as written is also **unenforceable**: `eslint-plugin-boundaries` matches element types
by path, not imported symbols, and `@nestjs/microservices` is legitimately imported outside
`messaging/` (`@EventPattern` in consumers, `@MessagePattern` in presentation). Today the rule
is upheld by code review alone.

## `SYM-005` — exception-file and RPC-filter naming drift

| Artefact | Majority | Outlier |
|---|---|---|
| Domain-exception file | `<x>.exception.ts` (catalog, pricing, inventory, cart, order, return) | `notification-domain.exception.ts` |
| RPC exception filter | singular (`cart-`, `catalog-`, `inventory-`, `notification-`, `pricing-`, `return-`) | `orders-rpc-exception.filter.ts` — the only plural |

Cosmetic; no behaviour depends on it. Worth folding into whichever pass touches those files next.

## `SYM-006` — functional asymmetries

- **Health surface.** Only the notification service has a `health.controller.ts`
  (`notification.health.ping`). The other five deployables expose no health check at all. This
  is a gap, not a naming drift — decide whether every service gets one or the one is removed.
- **Gateway admin shells.** `modules/iam/` has `application/use-cases/` but no
  `application/ports/` and no `infrastructure/`; `modules/customer-admin/` has only
  `presentation/`. They are the only modules in the repo without an application-port layer.
  Deliberate (ADR-024: they are shells over the `auth` aggregates, and consume auth's
  repositories through the sanctioned `shared-module-barrel` seam), but they do fall outside the
  hexagon the other sixteen modules keep.
- **`app.module.ts` import order.** notification puts `CacheModule` before `DatabaseModule`,
  inventory after. `CacheModule` is `@Global()`, so this is cosmetic.

## `SYM-007` — the four `runWith<X>WriteRetry` helpers are one protocol, written four times

`cart-write.ts` (99 lines), `order-write.ts` (83), `return-write.ts` (80), and
`stock-mutation.ts` (183, which also carries `applyOnHandChange`) each define a
`<X>WriteConflictError` and a `runWith<X>WriteRetry`. [ADR-036](../adr/036-idempotency-key-store-and-enforced-occ.md)
treats the per-module helper as a convention, and `CLAUDE.md` records it as such.

Unlike `SYM-001` / `SYM-002` these are **not byte-identical** — so this is not a move, it is a
generalisation, and it needs its own ADR.

**The loops are structurally identical.** Each is: `for attempt in 1..maxAttempts` → run the
work → if the error is not this module's conflict type, rethrow → if the budget is exhausted,
log `warn` and throw the module's `*DomainException` with `{ currentVersion }` → otherwise log
`info` and loop. Same order, same branches, same log levels (ADR-036 pins OCC retries at `info`),
same unreachable-tail guard.

**They vary in exactly three places:**

1. **The conflict type** caught — `OrderWriteConflictError` / `ReturnWriteConflictError` /
   `CartWriteConflictError` / `StockWriteConflictError`. All four carry `currentVersion`; they
   differ only in the id they also carry (`orderId`, `rmaId`, `cartId`, …).
2. **The exception thrown on exhaustion** — `OrderDomainException(ORDER_VERSION_MISMATCH, …)`
   vs `ReturnDomainException(RETURN_VERSION_MISMATCH, …)`, etc.
3. **The log wording and the id key** in the log context.

### Sketch of the generalisation

A shared `OccWriteConflictError` base in `libs/common/concurrency/` carrying `currentVersion` +
an `entityId`; each module's conflict error extends it. A generic
`runWithOccRetry<T>(deps, attempt, { onExhausted })` catches the base and delegates the terminal
throw to the module, which is the only part that must stay module-owned (its `*DomainException`
and error code are its own). The application-use-case layer may import `lib-common`, so the
placement is legal — the same check that decided `SYM-002`.

### The trade-off to weigh in the ADR

- **For.** ~340 lines collapse to one loop. The retry protocol — the thing ADR-036 actually
  specifies — becomes provably the same everywhere instead of four hand-copied approximations of
  it, and a fifth aggregate is free. The `info` / `warn` levels and the exhaustion contract stop
  being four independent chances to drift.
- **Against.** The module's terminal exception becomes a callback, which is one indirection more
  than a reader of `order-write.ts` faces today. The hand-written log wording ("Order write
  conflict — retrying with a fresh read") becomes parameterised and blander. And
  `stock-mutation.ts` only *partly* folds in: `applyOnHandChange` and the stock-specific
  invariants stay where they are, so inventory ends up with a smaller local file plus a lib
  import rather than a clean deletion.
- **Prior art in this repo.** The project already accepts a duplicate when the alternative is a
  broken boundary (`retry-then-log-for-replay.ts`, copied into `returns` because it may not
  import `orders`). That precedent does **not** apply here: nothing in the retry loop is
  module-specific, and lifting it breaks no boundary — the same reasoning that settled
  `SYM-001`.
