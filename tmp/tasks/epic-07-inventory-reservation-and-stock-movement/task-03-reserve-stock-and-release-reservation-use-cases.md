---
epic: epic-07
task_number: 3
title: Reserve Stock + Release Reservation use cases (OCC retry + cache invalidation)
depends_on: [01, 02]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/03-no-oversell-invariant-and-occ.md
---

# Task 03 — Reserve Stock + Release Reservation use cases

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-012](../../../docs/adr/012-stock-aggregate-and-port-adapter.md) — the existing `IStockEventsPublisherPort`; this task adds the three new emit methods to it.
  - [ADR-023](../../../docs/adr/023-cache-invalidate-post-commit-by-type.md) — Reserve/Release route writes through `stockCache.withInvalidation(work, resolveItems, opts)`; never resurrect a public `invalidate`.
  - [ADR-021](../../../docs/adr/021-cache-single-flight-and-ttl-jitter.md) — the read path uses `stockCache.getOrLoad`; skip-cache branches short-circuit before it.
  - [ADR-008](../../../docs/adr/008-rabbitmq-via-libs-messaging.md) / [ADR-020](../../../docs/adr/020-rabbitmq-as-inter-service-bus.md) — dotted routing keys; publishers live only in `infrastructure/messaging/*-rabbitmq.publisher.ts`; post-commit publish failures are `warn`-logged and swallowed.
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — `PinoLogger`; inside `@MessagePattern` handlers log `correlationId` inline (`assign()` throws outside request scope).

## Goal

Implement the two cart-write operations that make the **no-oversell invariant** real:

- **Reserve Stock** (System; triggered by Add to Cart) — checks `quantityOnHand − quantityAllocated − quantityReserved ≥ requested` inside one transaction with OCC on `stock_level.version`, then inserts/refreshes the `active` Reservation and bumps `stock_level.quantityReserved`. Idempotent on `(cartId, variantId, stockLocationId)`. Emits `StockReserved` + a `release`-free `StockMovement`? — **no**: Reserve does **not** write a StockMovement (a reservation is not yet a stock movement; only the allocation/sale/release transitions hit the ledger). It emits `StockReserved` and `inventory.stock-movement.recorded` is **not** emitted by Reserve. (Release *does* write a `release` movement — see below.)
- **Release Reservation** (System; triggered by Remove from Cart / Change Quantity / cart abandonment / TTL expiry) — flips the Reservation to `released` (or `expired`), decrements `stock_level.quantityReserved`, writes a `release`-type `StockMovement`, and emits `StockReleased` + `inventory.stock-movement.recorded`.

This task also **extends `IStockEventsPublisherPort`** with `publishStockReserved`, `publishStockReleased`, and `publishStockMovementRecorded`, implements them on `StockRabbitmqPublisher`, and registers the four new routing keys + the two reserve/release RPC patterns. (The third RPC, `inventory.reservation.allocate`, and the `inventory.stock.allocated` key land in task-04.)

> **Sign/ledger rule clarification.** A *reservation* does not move physical stock — it parks availability. So Reserve writes no `StockMovement`. A *release* of a reservation is recorded as a `release` movement (negative quantity) so the audit timeline shows the round-trip. Allocation (task-04) writes an `allocation` movement. This keeps the ledger meaning "physical/committed quantity changes", not "availability holds".

## Entry state assumed

Tasks 01–02 carryover present:

- `Reservation` aggregate + `reservation` table + `RESERVATION_REPOSITORY`.
- `StockMovement` aggregate + `stock_movement` table + `STOCK_MOVEMENT_REPOSITORY` (`append`/`appendMany`/`query`).
- `StockLevel` carries `quantityReserved` (default `0`, not yet mutated by any code path).
- `IStockEventsPublisherPort` exists with the `epic-04` emit surface (`publishStockReceived`, `publishStockAdjusted`, `publishStockLow`, `publishStockLevelInitialized`).
- `IStockCachePort.withInvalidation` + `getOrLoad` exist (ADR-021/ADR-023).
- `ITransactionPort` (`runInTransaction`) exists.

## Scope

**In:**

- `…/application/use-cases/reserve-stock.use-case.ts` + spec.
- `…/application/use-cases/release-reservation.use-case.ts` + spec.
- DTOs: `…/application/dto/{reserve-stock.command,release-reservation.command,reservation.view}.ts`.
- Extend `IStockEventsPublisherPort` (`…/application/ports/stock-events.publisher.port.ts`) with `publishStockReserved`, `publishStockReleased`, `publishStockMovementRecorded`.
- Implement those three on `StockRabbitmqPublisher` (`…/infrastructure/messaging/stock-rabbitmq.publisher.ts`).
- Routing keys in `libs/messaging/routing-keys.constants.ts`: `INVENTORY_STOCK_RESERVED`, `INVENTORY_STOCK_RELEASED`, `INVENTORY_STOCK_MOVEMENT_RECORDED` (event) + `INVENTORY_RESERVATION_RESERVE`, `INVENTORY_RESERVATION_RELEASE` (RPC). (`INVENTORY_STOCK_ALLOCATED` + `INVENTORY_RESERVATION_ALLOCATE` are task-04.)
- Wire contracts in `libs/contracts/inventory/events/`: `stock-reserved.event.ts`, `stock-released.event.ts`, `stock-movement-recorded.event.ts` (each extends `ICorrelationPayload` + `occurredAt: string` + `eventVersion: 'v1'`).
- `@MessagePattern` handlers in `…/presentation/stock.controller.ts` for `inventory.reservation.reserve` and `inventory.reservation.release`.
- `RESERVATION_TTL_MINUTES` env: add to the Joi schema (`libs/config`) with default `15`; the Reserve use case reads it.
- Doc deliverable `03-no-oversell-invariant-and-occ.md`.

**Out:**

- Allocate Stock + `inventory.stock.allocated` + `inventory.reservation.allocate` — task-04.
- Cancel Allocation — task-05.
- The cart-side caller (retail `INVENTORY_RESERVATION_GATEWAY`) — task-08.
- The cache key `v2`→`v3` bump — task-10 (this task uses whatever version is live; it routes through the cache *port*, not literal keys).

## Reserve Stock — transactional shape

The use case runs the whole check-and-mutate inside one transaction, wrapped by `withInvalidation` so the cache fan-out happens *after* commit (ADR-023):

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

import { Reservation, ReservationStatusEnum } from '../../domain';
import {
  IReservationRepositoryPort, RESERVATION_REPOSITORY,
  IStockRepositoryPort, STOCK_REPOSITORY,
  IStockCachePort, STOCK_CACHE,
  IStockEventsPublisherPort, STOCK_EVENTS_PUBLISHER,
  ITransactionPort, TRANSACTION_PORT,
} from '../ports';
import { OutOfStockError } from '../../domain/errors/out-of-stock.error';
import { OccConflictError } from '../../domain/errors/occ-conflict.error';
import { ReserveStockCommand } from '../dto/reserve-stock.command';
import { ReservationView } from '../dto/reservation.view';

const OCC_MAX_ATTEMPTS = 3;

@Injectable()
export class ReserveStockUseCase {
  constructor(
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: IReservationRepositoryPort,
    @Inject(STOCK_REPOSITORY) private readonly stock: IStockRepositoryPort,
    @Inject(STOCK_CACHE) private readonly stockCache: IStockCachePort,
    @Inject(STOCK_EVENTS_PUBLISHER) private readonly events: IStockEventsPublisherPort,
    @Inject(TRANSACTION_PORT) private readonly tx: ITransactionPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReserveStockUseCase.name);
  }

  public async execute(cmd: ReserveStockCommand): Promise<ReservationView> {
    const stockLocationId = cmd.stockLocationId ?? 'default-warehouse';
    const ttlMinutes = cmd.ttlMinutes; // injected from RESERVATION_TTL_MINUTES by the controller/DI
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    const reservation = await this.stockCache.withInvalidation(
      // (1) work — the transaction; (2) resolveItems — what to invalidate; (3) opts.
      () => this.runWithOccRetry(cmd, stockLocationId, expiresAt),
      (r) => [{ variantId: r.variantId, stockLocationId: r.stockLocationId }],
      { correlationId: cmd.correlationId },
    );

    // Post-commit, best-effort fan-out (warn-and-swallow on failure — ADR-020).
    await this.events.publishStockReserved({
      reservationId: reservation.id,
      variantId: reservation.variantId,
      stockLocationId: reservation.stockLocationId,
      quantity: reservation.quantity,
      cartId: reservation.cartId,
      expiresAt: reservation.expiresAt.toISOString(),
      correlationId: cmd.correlationId,
    });

    return ReservationView.from(reservation);
  }

  private async runWithOccRetry(
    cmd: ReserveStockCommand,
    stockLocationId: string,
    expiresAt: Date,
  ): Promise<Reservation> {
    for (let attempt = 1; attempt <= OCC_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.tx.runInTransaction(async (scope) => {
          const level = await this.stock.findByVariantAndLocation(cmd.variantId, stockLocationId, scope);
          if (level === null) {
            throw new OutOfStockError(cmd.variantId, stockLocationId, 0);
          }

          // Idempotency: an existing reservation for the triple is refreshed, and
          // its old quantity is "returned" before re-checking availability.
          const existing = await this.reservations.findByCartVariantLocation(
            cmd.cartId, cmd.variantId, stockLocationId, scope,
          );
          const alreadyHeld = existing?.status === ReservationStatusEnum.Active ? existing.quantity : 0;

          const available = level.available + alreadyHeld; // give back this cart's own hold first
          if (available < cmd.quantity) {
            throw new OutOfStockError(cmd.variantId, stockLocationId, level.available);
          }

          // Mutate stock_level.quantityReserved by the delta; the OCC token guards
          // concurrent writers. reserveDelta can be negative on a quantity decrease.
          const reserveDelta = cmd.quantity - alreadyHeld;
          await this.stock.adjustReserved({ variantId: cmd.variantId, stockLocationId, delta: reserveDelta }, scope);

          const reservation = existing
            ? (existing.refresh(cmd.quantity, expiresAt), existing)
            : new Reservation({
                id: randomUUID(),
                variantId: cmd.variantId,
                stockLocationId,
                quantity: cmd.quantity,
                cartId: cmd.cartId,
                expiresAt,
              });
          return this.reservations.save(reservation, scope);
        });
      } catch (err) {
        if (err instanceof OccConflictError && attempt < OCC_MAX_ATTEMPTS) {
          this.logger.warn({ correlationId: cmd.correlationId, attempt }, 'OCC conflict on reserve; retrying');
          continue;
        }
        throw err;
      }
    }
    // Unreachable — the loop either returns or throws.
    throw new OccConflictError(cmd.variantId, stockLocationId);
  }
}
```

Key points to honor:

- **`adjustReserved(...)` is a new method on `IStockRepositoryPort`** (add it in this task): an atomic SQL `UPDATE stock_level SET quantity_reserved = quantity_reserved + :delta, version = version + 1 WHERE variant_id = ? AND stock_location_id = ? AND version = ? AND quantity_on_hand - quantity_allocated - (quantity_reserved + :delta) >= 0`. Zero rows affected ⇒ throw `OccConflictError` (the use case translates to a retry, then to a `409`). The `WHERE` clause is the no-oversell guard in SQL — it cannot reserve below zero available even under a lost update.
- **`OutOfStockError`** carries the available count so the RPC response can return `OUT_OF_STOCK` with `available`. The gateway maps it to `409` (task-09 / task-08).
- **`OccConflictError`** after `OCC_MAX_ATTEMPTS` retries surfaces as `409` to the caller (distinct from `OUT_OF_STOCK` — a conflict is "try again", out-of-stock is "no").
- **No StockMovement on Reserve** (see the Goal clarification).
- The `withInvalidation` `work` returns the `Reservation`; `resolveItems` derives the single `{ variantId, stockLocationId }` to fan out the `delByPrefix` calls post-commit. Never call a public `invalidate` (ADR-023).

## Release Reservation — shape

```ts
public async execute(cmd: ReleaseReservationCommand): Promise<ReleaseReservationResult> {
  const released = await this.stockCache.withInvalidation(
    () => this.tx.runInTransaction(async (scope) => {
      // Release one (by reservationId) or all active for a cart (by cartId).
      const targets = cmd.reservationId
        ? [await this.requireReservation(cmd.reservationId, scope)]
        : await this.reservations.findActiveByCart(cmd.cartId!, scope);

      const result: Reservation[] = [];
      for (const r of targets) {
        if (r.status !== ReservationStatusEnum.Active) continue; // idempotent
        cmd.reason === 'expired' ? r.expire() : r.release();
        await this.stock.adjustReserved(
          { variantId: r.variantId, stockLocationId: r.stockLocationId, delta: -r.quantity }, scope,
        );
        await this.reservations.save(r, scope);
        await this.movements.append(
          StockMovement.record({
            variantId: r.variantId, stockLocationId: r.stockLocationId,
            type: StockMovementTypeEnum.Release, quantity: -r.quantity,
            referenceType: 'cart', referenceId: r.cartId, reasonCode: cmd.reason,
          }), scope,
        );
        result.push(r);
      }
      return result;
    }),
    (rs) => rs.map((r) => ({ variantId: r.variantId, stockLocationId: r.stockLocationId })),
    { correlationId: cmd.correlationId },
  );

  for (const r of released) {
    await this.events.publishStockReleased({ /* …variantId, stockLocationId, quantity, cartIdOrOrderId: r.cartId, reason: cmd.reason… */ });
    await this.events.publishStockMovementRecorded({ /* echo the release movement row */ });
  }
  return { released: released.map((r) => r.id) };
}
```

- `reason` is `'cart-removed' | 'expired' | 'order-cancelled'` on the wire (matches the `inventory.stock.released` payload).
- Releasing an already-released/expired reservation is a **no-op** (idempotent) — the loop skips non-active rows. This matters for the cart-abandonment path and the future sweeper double-firing.
- `adjustReserved` with a negative delta here uses the same atomic UPDATE but with a relaxed guard (releasing never violates the non-negative-available invariant; the `WHERE version = ?` OCC token still applies).

## Events publisher extension

Add to `IStockEventsPublisherPort`:

```ts
publishStockReserved(payload: IStockReservedEvent): Promise<void>;
publishStockReleased(payload: IStockReleasedEvent): Promise<void>;
publishStockMovementRecorded(payload: IStockMovementRecordedEvent): Promise<void>;
```

Implement on `StockRabbitmqPublisher` exactly like the existing `publishStockLow` — `firstValueFrom(this.client.emit(ROUTING_KEYS.INVENTORY_STOCK_RESERVED, payload))` wrapped in a try/catch that `warn`-logs and swallows (ADR-020). The wire interfaces live in `libs/contracts/inventory/events/` and are imported by both the publisher and `epic-11`'s future consumer so a drift fails TypeScript on both ends.

## Files to add

- `…/application/use-cases/reserve-stock.use-case.ts` + `…/spec/reserve-stock.use-case.spec.ts`
- `…/application/use-cases/release-reservation.use-case.ts` + `…/spec/release-reservation.use-case.spec.ts`
- `…/application/dto/{reserve-stock.command,release-reservation.command,reservation.view}.ts`
- `…/domain/errors/{out-of-stock,occ-conflict}.error.ts` (if not already present from `epic-04`)
- `libs/contracts/inventory/events/{stock-reserved,stock-released,stock-movement-recorded}.event.ts`
- `docs/implementation/07-inventory-reservation-and-stock-movement/03-no-oversell-invariant-and-occ.md`

## Files to modify

- `…/application/ports/stock.repository.port.ts` — add `adjustReserved(payload, scope?)`.
- `…/application/ports/stock-events.publisher.port.ts` — add the three emit methods.
- `…/infrastructure/persistence/stock-typeorm.repository.ts` — implement `adjustReserved` as the atomic guarded UPDATE.
- `…/infrastructure/messaging/stock-rabbitmq.publisher.ts` — implement the three new emits.
- `…/presentation/stock.controller.ts` — `@MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_RESERVE)` and `…RELEASE` handlers (inline `correlationId` logging).
- `…/infrastructure/stock.module.ts` — register `ReserveStockUseCase` + `ReleaseReservationUseCase`.
- `libs/messaging/routing-keys.constants.ts` — add the five new keys (3 event + 2 RPC).
- `libs/contracts/inventory/index.ts` (or events barrel) — export the three event interfaces.
- `libs/config/*` — add `RESERVATION_TTL_MINUTES` to the Joi schema (default `15`, positive integer).

## Files to delete

None.

## Tests

`reserve-stock.use-case.spec.ts` (fake repositories + fake transaction port that runs the callback inline):

- **Happy path:** available ≥ requested → reservation created `active`; `quantityReserved` increased by the requested amount; `publishStockReserved` called once; **no StockMovement appended**.
- **OUT_OF_STOCK:** available < requested → `OutOfStockError` with the available count; nothing persisted; no event.
- **Idempotency on `(cartId, variantId, stockLocationId)`:** a second call with a different quantity refreshes the existing reservation (`expiresAt` re-stamped, quantity updated) and adjusts `quantityReserved` by the *delta* only (not the full new quantity).
- **OCC retry-then-success:** a fake repo that throws `OccConflictError` on the first `adjustReserved` and succeeds on the second → the reservation is created and the spec asserts exactly two attempts.
- **OCC retry-then-fail:** the fake throws `OccConflictError` on all three attempts → the use case surfaces `OccConflictError` (mapped to `409`).

`release-reservation.use-case.spec.ts`:

- Release by `reservationId` → reservation `released`; `quantityReserved` decremented; one `release` StockMovement appended (negative quantity); `publishStockReleased` + `publishStockMovementRecorded` each called once.
- Release-all by `cartId` → every active reservation released; already-released ones skipped (idempotent, no double-decrement).
- `reason: 'expired'` → reservation flipped to `expired` (not `released`).

## Doc deliverable — `03-no-oversell-invariant-and-occ.md`

Target ~170 lines. Sections:

1. **The no-oversell invariant.** Restate Cross-Cutting §"Concurrency & consistency": `quantityOnHand − quantityAllocated − quantityReserved ≥ requested`, enforced atomically. Two carts racing for the last unit: exactly one wins.
2. **Why the guard lives in the SQL `WHERE`, not in app code.** The `adjustReserved` UPDATE's `WHERE … - (quantity_reserved + :delta) >= 0 AND version = ?` clause makes the check-and-mutate one atomic statement — a lost update cannot oversell because the loser's `WHERE` matches zero rows. Contrast with read-check-write in app code (a TOCTOU race).
3. **The OCC token + retry policy.** `@VersionColumn` on `stock_level`; the `WHERE version = ?` clause; zero-rows ⇒ `OccConflictError`; the use case retries up to 3 times then surfaces `409`. Why `REPEATABLE READ` (MySQL default) + OCC, not `SERIALIZABLE`.
4. **OUT_OF_STOCK vs OCC conflict — two different 409s.** OUT_OF_STOCK is terminal for this request (return the available count); OCC conflict is "retry" (retried internally, only surfaced if it persists).
5. **Idempotency on the cart triple.** The unique `(cart_id, variant_id, stock_location_id)` index; refresh-not-duplicate; the `reserveDelta = new − alreadyHeld` arithmetic so a quantity change adjusts `quantityReserved` correctly.
6. **Why Reserve writes no StockMovement but Release does.** The ledger records *physical/committed* changes, not availability holds. Reserve parks availability (reversible, TTL-bounded); Release records a `release` movement so the audit timeline shows the round-trip. Forward link to doc `02-…`.
7. **ADR-023 post-commit invalidation preserved.** Both use cases wrap their transaction in `stockCache.withInvalidation(work, resolveItems, opts)` — the cache fan-out runs only after commit, derived by type from the resolved value. No public `invalidate`.
8. **Event emission (Cross-Cutting).** `StockReserved` + `StockReleased` are mandatory and emitted here; `StockAllocated` arrives in task-04; `StockCommitted` (sale) in `epic-08`. Post-commit publish is best-effort (warn-and-swallow).
9. **What this task did NOT do.** Forward links to task-04 (allocate consumes the active reservation via `commit()`), task-08 (the cart-side caller), task-10 (cache key bump).

## Carryover produced (consumed by task-04 onward)

- `ReserveStockUseCase` + `ReleaseReservationUseCase` reachable over `inventory.reservation.reserve` / `inventory.reservation.release`.
- `IStockRepositoryPort.adjustReserved` (atomic guarded UPDATE) on the repository.
- `IStockEventsPublisherPort` extended with the three emits; `StockRabbitmqPublisher` implements them.
- Five new routing keys + three wire-event contracts.
- `RESERVATION_TTL_MINUTES` in the Joi schema.
- Doc `03-no-oversell-invariant-and-occ.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; both use-case specs green, including the OCC retry-then-success and retry-then-fail cases.
- [ ] `yarn build` succeeds (the new contracts compile on both publisher and future-consumer side).
- [ ] Reserving on a variant with `available = 0` throws `OutOfStockError` with `available: 0`.
- [ ] Concurrent reserves never drive `available` negative (asserted by the SQL-guard test in the repository spec or the use-case OCC test).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `03-no-oversell-invariant-and-occ.md` exists with the sections above.
