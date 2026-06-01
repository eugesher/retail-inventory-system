---
epic: epic-07
task_number: 11
title: Concurrent-oversell + reservation/allocation e2e tests
depends_on: [01, 02, 03, 04, 05, 06, 07, 08, 09, 10]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/10-concurrent-oversell-e2e.md
---

# Task 11 — Concurrent-oversell + reservation e2e tests

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-020](../../../docs/adr/020-rabbitmq-as-inter-service-bus.md) — the e2e exercises the full gateway → retail → inventory RPC chain over RabbitMQ.
  - [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) — the no-oversell guard is a real DB-level invariant; the e2e proves it under concurrency.
  - [ADR-021](../../../docs/adr/021-cache-single-flight-and-ttl-jitter.md) / [ADR-023](../../../docs/adr/023-cache-invalidate-post-commit-by-type.md) — the cache must not mask a stale availability under concurrency.
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — `PinoLogger` in any test helper; no `@nestjs/common` `Logger`.

## Goal

Author the e2e suite that **proves** the epic's headline guarantee. The centerpiece is `test/concurrent-oversell.e2e-spec.ts`, the report's **Stage-2 acceptance criterion**: it must be green and **stable across 5 consecutive runs**. Three supporting specs exercise the reserve→release and place→allocate chains and the audit timeline.

These tests run against the real test infrastructure (`yarn test:infra:up` → MySQL + Redis + RabbitMQ) with the full app stack — the point is to catch races that unit tests with fake repositories cannot.

## Entry state assumed

Tasks 01–10 complete:

- All inventory RPCs live (`reserve`/`release`/`allocate`/`movement.query`/`stock.transfer`).
- The cart use cases call inventory across the bus (task-08).
- The audit + ops endpoints live (task-09).
- The cache is on `v3` (task-10).
- The test harness from `epic-04`/`epic-05` exists (`test:infra:*`, `test:seed`, the e2e bootstrap).

## Scope

**In:**

- `test/concurrent-oversell.e2e-spec.ts` — the required concurrency proof.
- `test/cart-reserve-release.e2e-spec.ts` — add/change/remove/abandon → reservation lifecycle.
- `test/place-order-allocates.e2e-spec.ts` — cart→place → Reservation→committed + allocation movement.
- `test/inventory-movements-audit.e2e-spec.ts` — receive/adjust/allocate/release timeline via `GET /…/movements`.
- Any seed helpers needed (a variant with a controlled `quantityOnHand`) — prefer extending the `epic-04` test seed pattern rather than ad-hoc inserts.
- Doc deliverable `10-concurrent-oversell-e2e.md`.

**Out:**

- The seed data + `.env` additions — task-13 (this task may reference the seeded fixtures; the canonical seed extension is task-13). For a self-contained concurrency test, set up its own variant with `quantityOnHand=1` in a `beforeAll`.
- README/CLAUDE updates — task-13.

## `concurrent-oversell.e2e-spec.ts` — the canonical test

Setup: a Variant with `quantityOnHand = 1` at `default-warehouse`, `quantityReserved = 0`, `quantityAllocated = 0`. Two distinct carts.

```ts
it('lets exactly one of two racing carts reserve the last unit', async () => {
  const [resA, resB] = await Promise.allSettled([
    addToCart(cartA, variantId, 1),  // POST /api/cart/:cartA/lines
    addToCart(cartB, variantId, 1),  // POST /api/cart/:cartB/lines
  ]);

  const statuses = [resA, resB].map((r) => (r.status === 'fulfilled' ? r.value.status : r.reason.status));
  // Exactly one 2xx, exactly one 409 OUT_OF_STOCK.
  expect(statuses.filter((s) => s < 400)).toHaveLength(1);
  const loser = [resA, resB].find((r) => r.status === 'rejected' || r.value.status === 409);
  expect(bodyOf(loser).code).toBe('OUT_OF_STOCK');
  expect(bodyOf(loser).available).toBe(0);

  // State is consistent: quantityReserved === 1, no negative quantities.
  const level = await getStockLevel(variantId);
  expect(level.quantityReserved).toBe(1);
  expect(level.available).toBe(0);
});

it('lets the winner place after the loser releases; exactly one allocation movement', async () => {
  // loser releases (DELETE /api/cart/:loser/lines/:lineId) — but the winner already
  // holds the unit, so the winner places and allocates.
  await placeOrder(winnerCart);                       // POST /api/cart/:winner/place
  const level = await getStockLevel(variantId);
  expect(level.quantityAllocated).toBe(1);
  expect(level.quantityReserved).toBe(0);
  const movements = await getMovements(variantId);    // GET /api/inventory/variants/:id/movements
  expect(movements.items.filter((m) => m.type === 'allocation')).toHaveLength(1);
  // No orphaned reservations, no negative quantities.
  expect(level.available).toBeGreaterThanOrEqual(0);
});
```

**Stability discipline (the 5-run criterion):**

- The two requests must be issued concurrently (`Promise.allSettled` on two in-flight HTTP calls), not sequentially — otherwise the race never happens and the test is vacuously green.
- No `sleep`-based synchronization that could flake. Assert on the *outcome invariant* (exactly one winner, consistent final state), not on timing.
- The test seeds its own variant in `beforeAll` and tears it down in `afterAll` so repeated runs start from `quantityOnHand=1` every time (the 5-consecutive-run requirement implies idempotent setup).
- Document in the spec header (and doc `10-…`) the command to run it five times: e.g. `for i in 1 2 3 4 5; do yarn test:e2e:run --testPathPattern concurrent-oversell || break; done`.

## `cart-reserve-release.e2e-spec.ts`

- Add-to-cart writes an `active` Reservation (assert via DB or via the reservation surfaced in the cart line); `quantityReserved` increments.
- Change-quantity refreshes the same reservation (same row id, new quantity, `expiresAt` re-stamped); `quantityReserved` adjusts by the delta.
- Remove-from-cart flips the reservation to `released`; `quantityReserved` decrements; a `release` StockMovement appears.
- Cart abandonment (the release-all path, however `epic-05`/task-08 expose it) releases all active reservations for the cart.

## `place-order-allocates.e2e-spec.ts`

- Full cart→place chain: add two lines, place; assert each Reservation → `committed`; exactly one `allocation` StockMovement per line; `quantityAllocated`/`quantityReserved` consistent.
- Redis check: after the place, `ris:inventory:stock:v3:<variantId>` reflects the post-allocation availability (cache invalidated post-commit per ADR-023); no `v2` key is written.

## `inventory-movements-audit.e2e-spec.ts`

- Receive (+N) → Adjust (±M) → reserve+place (allocation) → cancel/release sequence produces the expected ordered timeline via `GET /api/inventory/variants/:id/movements`.
- Pagination + `?type=` filter return the expected subsets.
- The `inventory:read` gate: an unauthenticated / under-permissioned token gets `403`.

## Files to add

- `test/concurrent-oversell.e2e-spec.ts`
- `test/cart-reserve-release.e2e-spec.ts`
- `test/place-order-allocates.e2e-spec.ts`
- `test/inventory-movements-audit.e2e-spec.ts`
- `docs/implementation/07-inventory-reservation-and-stock-movement/10-concurrent-oversell-e2e.md`
- (optional) `test/helpers/inventory.helpers.ts` — `addToCart`, `placeOrder`, `getStockLevel`, `getMovements` thin wrappers if the existing e2e harness has no equivalents.

## Files to modify

- The e2e bootstrap / `jest-e2e.json` config only if a new test path or setup hook is required (prefer reusing the existing harness).

## Files to delete

None.

## Tests

This task *is* the tests. The gate is:

- All four specs green via `yarn test:e2e`.
- `concurrent-oversell.e2e-spec.ts` green across **5 consecutive runs** (the documented loop).

## Doc deliverable — `10-concurrent-oversell-e2e.md`

Target ~110 lines. Sections:

1. **What the test proves.** The no-oversell invariant under real concurrency: two carts, one unit, exactly one winner — the Stage-2 acceptance criterion.
2. **How to run it.** `yarn test:infra:up` → `yarn test:seed` → `yarn test:e2e:run --testPathPattern concurrent-oversell`; the 5-consecutive-run loop and why stability (not just a single green) is the bar.
3. **Why it's stable, not flaky.** Concurrent issue (not sequential); outcome-invariant assertions (not timing); idempotent per-run setup. What would make it flaky and how each is avoided.
4. **Reading a failure.** If both carts win → the SQL guard or OCC token regressed (a lost update overslept). If both lose → an over-eager guard or a cache masking fresh availability. If the final state is inconsistent (`quantityReserved` ≠ expected, a negative quantity, ≠1 allocation movement) → the transaction boundary or the post-commit invalidation regressed.
5. **The supporting specs.** One line each on cart-reserve-release, place-order-allocates, movements-audit and what each guards.

## Carryover produced (consumed by task-12 onward)

- Four green e2e specs; the concurrency proof is stable.
- Doc `10-concurrent-oversell-e2e.md` exists.

## Exit criteria

- [ ] `yarn test:e2e` passes; all four new specs green.
- [ ] `test/concurrent-oversell.e2e-spec.ts` is green across 5 consecutive runs.
- [ ] Place Order produces exactly one `allocation` StockMovement per line (asserted by `place-order-allocates`).
- [ ] `redis-cli --scan --pattern 'ris:inventory:stock:v3:*'` shows v3 entries after the place; no v2 entries written.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `10-concurrent-oversell-e2e.md` exists with the sections above.
