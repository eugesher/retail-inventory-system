---
epic: epic-07
task_number: 4
title: Allocate Stock use case (Reservation→committed, fallback, expired-rejection)
depends_on: [01, 02, 03]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/05-allocate-on-place.md
---

# Task 04 — Allocate Stock use case

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-013](../../../docs/adr/013-order-aggregate-and-cross-service-confirm.md) — the existing cross-service confirm flow that Allocate replaces/extends (Place Order → Allocate).
  - [ADR-023](../../../docs/adr/023-cache-invalidate-post-commit-by-type.md) — Allocate routes its write through `stockCache.withInvalidation`.
  - [ADR-012](../../../docs/adr/012-stock-aggregate-and-port-adapter.md) — `IStockEventsPublisherPort`; events emitted from the use case post-commit, not pulled from an aggregate.
  - [ADR-008](../../../docs/adr/008-rabbitmq-via-libs-messaging.md) / [ADR-020](../../../docs/adr/020-rabbitmq-as-inter-service-bus.md) — the new `inventory.stock.allocated` key + `inventory.reservation.allocate` RPC.
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — `PinoLogger`; inline `correlationId` in the RMQ handler.

## Goal

Implement **Allocate Stock** (System; triggered by Place Order). For each cart line, the common path commits the cart's matching active `Reservation`: `Reservation → committed`, write an `allocation`-type `StockMovement`, `stock_level.quantityAllocated += n`, `stock_level.quantityReserved -= n`, emit `StockAllocated`. The use case also handles two non-common paths the epic names explicitly:

- **Fallback (no active reservation):** if a cart line has no active reservation (e.g. it was never reserved, or expired between add and place) but there is sufficient *unreserved* available stock, allocate directly: `quantityAllocated += n` without touching `quantityReserved`, write the `allocation` movement, emit `StockAllocated`.
- **Expired-reservation rejection:** a reservation whose `expiresAt < now` cannot be committed. The allocate path either (a) refreshes via the fallback if unreserved stock is still available, or (b) fails the place with `OUT_OF_STOCK` if not. Per the epic Non-Goals, the wall-clock sweeper is `epic-14`; the **inline TTL check at allocate-time lives here**.

This task registers the `inventory.reservation.allocate` RPC and the `inventory.stock.allocated` routing key (the two left out of task-03).

## Entry state assumed

Tasks 01–03 carryover present:

- `Reservation.commit(now)` exists (task-01) and throws on an expired reservation.
- `IStockRepositoryPort.adjustReserved` exists (task-03); this task adds the sibling `adjustAllocated`.
- `IStockEventsPublisherPort` has `publishStockReserved`/`publishStockReleased`/`publishStockMovementRecorded`; this task adds `publishStockAllocated`.
- `STOCK_MOVEMENT_REPOSITORY` (`append`/`appendMany`) exists.
- `inventory.reservation.reserve` / `…release` RPCs are live; `…allocate` is not yet.

## Scope

**In:**

- `…/application/use-cases/allocate-stock.use-case.ts` + spec.
- DTOs: `…/application/dto/{allocate-stock.command,allocate-stock.result}.ts` — request `{ cartId, orderId, correlationId }`, response `{ allocated: [{ variantId, stockLocationId, quantity }] }`.
- Extend `IStockEventsPublisherPort` with `publishStockAllocated`; implement on `StockRabbitmqPublisher`.
- `IStockRepositoryPort.adjustAllocated(payload, scope?)` — atomic guarded UPDATE.
- Routing keys: `INVENTORY_STOCK_ALLOCATED` (event) + `INVENTORY_RESERVATION_ALLOCATE` (RPC).
- Wire contract `libs/contracts/inventory/events/stock-allocated.event.ts`.
- `@MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_ALLOCATE)` handler in `stock.controller.ts`.
- Doc deliverable `05-allocate-on-place.md` (Cancel-Allocation reversal note appended by task-05).

**Out:**

- Cancel Allocation — task-05.
- The retail-side caller (Place Order → `INVENTORY_RESERVATION_GATEWAY.allocate`) — task-08.
- Commit Sale (the on-ship physical decrement + `StockCommitted`) — `epic-08`.

## Allocate — transactional shape

The RPC carries `{ cartId, orderId }`; the use case finds all active reservations for the cart (the lines to allocate) and processes each inside one transaction wrapped by `withInvalidation`:

```ts
public async execute(cmd: AllocateStockCommand): Promise<AllocateStockResult> {
  const now = new Date();

  const allocated = await this.stockCache.withInvalidation(
    () => this.tx.runInTransaction(async (scope) => {
      const reservations = await this.reservations.findActiveByCart(cmd.cartId, scope);
      const lines: AllocatedLine[] = [];

      for (const r of reservations) {
        if (r.isExpiredAt(now)) {
          // Expired: try the fallback against unreserved available; else fail the place.
          await this.allocateFallback(r.variantId, r.stockLocationId, r.quantity, cmd, scope, r, now);
          lines.push({ variantId: r.variantId, stockLocationId: r.stockLocationId, quantity: r.quantity });
          continue;
        }
        // Common path: commit the reservation.
        r.commit(now);                                  // active → committed (throws if expired)
        await this.reservations.save(r, scope);
        await this.stock.adjustAllocated(
          { variantId: r.variantId, stockLocationId: r.stockLocationId, reservedDelta: -r.quantity, allocatedDelta: r.quantity },
          scope,
        );
        await this.movements.append(
          StockMovement.record({
            variantId: r.variantId, stockLocationId: r.stockLocationId,
            type: StockMovementTypeEnum.Allocation, quantity: -r.quantity,
            referenceType: 'order', referenceId: cmd.orderId, reasonCode: 'allocate-on-place',
          }), scope,
        );
        lines.push({ variantId: r.variantId, stockLocationId: r.stockLocationId, quantity: r.quantity });
      }
      return lines;
    }),
    (lines) => lines.map((l) => ({ variantId: l.variantId, stockLocationId: l.stockLocationId })),
    { correlationId: cmd.correlationId },
  );

  for (const l of allocated) {
    await this.events.publishStockAllocated({
      variantId: l.variantId, stockLocationId: l.stockLocationId, quantity: l.quantity,
      orderId: cmd.orderId, reservationIdOptional: l.reservationId ?? null,
      correlationId: cmd.correlationId,
    });
    await this.events.publishStockMovementRecorded({ /* echo the allocation movement */ });
  }
  return { allocated };
}
```

- **`adjustAllocated`** is a new atomic UPDATE on `IStockRepositoryPort`: `UPDATE stock_level SET quantity_reserved = quantity_reserved + :reservedDelta, quantity_allocated = quantity_allocated + :allocatedDelta, version = version + 1 WHERE variant_id = ? AND stock_location_id = ? AND version = ? AND quantity_on_hand - (quantity_allocated + :allocatedDelta) >= 0`. On the common path `reservedDelta = -n` (the hold becomes an allocation); on the fallback `reservedDelta = 0`. Zero rows ⇒ `OccConflictError`, retried up to 3 times then surfaced (same policy as task-03 — factor the retry helper if it's already shared).
- **`allocateFallback(...)`** (private): re-checks `level.available ≥ quantity` for the unreserved path; if ok, `adjustAllocated({ reservedDelta: 0, allocatedDelta: quantity })`, expire the stale reservation row, write the `allocation` movement; if not, throw `OutOfStockError` (the whole place fails — the transaction rolls back, nothing partially allocated).
- **All-or-nothing per place:** because every line is inside one transaction, a single `OutOfStockError` rolls back the entire allocation. The retail-side Place Order use case (task-08) surfaces this as a failed placement.

## Files to add

- `…/application/use-cases/allocate-stock.use-case.ts` + `…/spec/allocate-stock.use-case.spec.ts`
- `…/application/dto/{allocate-stock.command,allocate-stock.result}.ts`
- `libs/contracts/inventory/events/stock-allocated.event.ts`

## Files to modify

- `…/application/ports/stock.repository.port.ts` — add `adjustAllocated(payload, scope?)`.
- `…/application/ports/stock-events.publisher.port.ts` — add `publishStockAllocated`.
- `…/infrastructure/persistence/stock-typeorm.repository.ts` — implement `adjustAllocated`.
- `…/infrastructure/messaging/stock-rabbitmq.publisher.ts` — implement `publishStockAllocated`.
- `…/presentation/stock.controller.ts` — `@MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_ALLOCATE)` handler.
- `…/infrastructure/stock.module.ts` — register `AllocateStockUseCase`.
- `libs/messaging/routing-keys.constants.ts` — add `INVENTORY_STOCK_ALLOCATED` + `INVENTORY_RESERVATION_ALLOCATE`.
- `libs/contracts/inventory/index.ts` (events barrel) — export `IStockAllocatedEvent`.
- `docs/implementation/07-inventory-reservation-and-stock-movement/05-allocate-on-place.md` — new file (task-05 appends).

## Files to delete

None.

## Tests

`allocate-stock.use-case.spec.ts`:

- **Common path:** an active reservation → `committed`; `quantityAllocated += n`; `quantityReserved -= n`; exactly one `allocation` StockMovement (negative quantity, `referenceType:'order'`); `publishStockAllocated` once per line.
- **Fallback:** no active reservation but `available ≥ n` → `quantityAllocated += n`, `quantityReserved` unchanged; one `allocation` movement; `StockAllocated` emitted.
- **Expired reservation, fallback succeeds:** reservation `expiresAt < now`, unreserved stock available → allocates via fallback; stale reservation flipped to `expired`.
- **Expired reservation, fallback fails:** `expiresAt < now`, insufficient unreserved stock → `OutOfStockError`; the whole transaction rolls back (assert no partial mutation, no movement persisted, no event).
- **OCC retry:** `adjustAllocated` throws `OccConflictError` once then succeeds → two attempts, allocation completes.

## Doc deliverable — `05-allocate-on-place.md`

Target ~140 lines (task-05 appends ~30 for the cancel reversal). Sections:

1. **Place Order → Allocate.** The flow from the retail Place Order use case (task-08 wires the caller) through the `inventory.reservation.allocate` RPC. Q9's "immediate commit on order placement" realized.
2. **Reservation → committed semantics.** The common path: the active reservation becomes `committed`; the hold (`quantityReserved`) converts into a commitment (`quantityAllocated`); the `allocation` StockMovement records the transition.
3. **The fallback path.** When there's no active reservation (never reserved, or expired). Why a fallback at all (resilience — a place shouldn't fail just because a reservation lapsed if stock is still there). The unreserved-availability check.
4. **Expired-reservation handling at allocate-time.** The inline `isExpiredAt(now)` check (the wall-clock sweeper is `epic-14`); refresh-via-fallback if possible, else fail the place. Why this is correct even without the sweeper: an expired reservation's `quantityReserved` is still held until released/swept, so the fallback's unreserved check is conservative.
5. **All-or-nothing per place.** One transaction across all lines; a single line's `OutOfStockError` rolls back the whole allocation. The retail side surfaces a failed placement.
6. **ADR-023 invalidation + event emission.** `withInvalidation` wraps the transaction; `StockAllocated` + `stock-movement.recorded` emitted post-commit, best-effort.
7. **What this task did NOT do.** Forward links to task-05 (Cancel Allocation reverses an allocation), `epic-08` (Commit Sale decrements `quantityOnHand` on ship), task-08 (the caller).

## Carryover produced (consumed by task-05 onward)

- `AllocateStockUseCase` reachable over `inventory.reservation.allocate`.
- `IStockRepositoryPort.adjustAllocated` on the repository.
- `publishStockAllocated` on the publisher + the `inventory.stock.allocated` key + wire contract.
- Doc `05-allocate-on-place.md` exists (Place→Allocate half).

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `allocate-stock.use-case.spec.ts` green across all five cases.
- [ ] `yarn build` succeeds.
- [ ] A place against a fully-expired reservation with no unreserved stock fails cleanly (transaction rolled back; no partial allocation).
- [ ] Exactly one `allocation` StockMovement per line on the happy path.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `05-allocate-on-place.md` exists with the Place→Allocate sections above.
