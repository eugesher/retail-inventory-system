---
epic: epic-07
task_number: 5
title: Cancel Allocation use case + RPC handler stub
depends_on: [01, 02, 03, 04]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/05-allocate-on-place.md
---

# Task 05 — Cancel Allocation use case + RPC handler stub

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-013](../../../docs/adr/013-order-aggregate-and-cross-service-confirm.md) — the order/inventory cross-service seam; Cancel Allocation is invoked by `epic-08`'s Cancel Order.
  - [ADR-023](../../../docs/adr/023-cache-invalidate-post-commit-by-type.md) — Cancel routes its write through `stockCache.withInvalidation`.
  - [ADR-008](../../../docs/adr/008-rabbitmq-via-libs-messaging.md) / [ADR-020](../../../docs/adr/020-rabbitmq-as-inter-service-bus.md) — the RPC handler stub for `epic-08`'s caller; `release` movement; `StockReleased` reuse.
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — `PinoLogger`; inline `correlationId` in the RMQ handler.

## Goal

Implement **Cancel Allocation** (System; triggered by Cancel Order, which `epic-08` owns). It is the reversal of Allocate: `stock_level.quantityAllocated -= n`, write a `release`-type `StockMovement`, emit `StockReleased`. Because `epic-08` is the only caller and is not yet built, this task also ships the **RPC handler stub** — a `@MessagePattern` wired to the use case so `epic-08`'s caller has a concrete wire to bind to — and registers no new routing key beyond the cancel RPC pattern (it reuses `inventory.stock.released` for the event).

This task is intentionally small: the heavy machinery (`adjustAllocated`, `withInvalidation`, the publisher emits, the OCC retry helper) all exist from tasks 03–04. Cancel Allocation reuses them with `allocatedDelta: -n` and `reservedDelta: 0`.

## Entry state assumed

Tasks 01–04 carryover present:

- `IStockRepositoryPort.adjustAllocated` exists (task-04).
- `IStockEventsPublisherPort.publishStockReleased` + `publishStockMovementRecorded` exist (task-03).
- `STOCK_MOVEMENT_REPOSITORY.append` exists.
- The `inventory.stock.released` routing key exists (task-03).

## Scope

**In:**

- `…/application/use-cases/cancel-allocation.use-case.ts` + spec.
- DTOs: `…/application/dto/{cancel-allocation.command,cancel-allocation.result}.ts` — request `{ orderId, lines: [{ variantId, stockLocationId?, quantity }], correlationId }`, response `{ cancelled: [...] }`.
- Routing key `INVENTORY_ALLOCATION_CANCEL` (RPC pattern; `inventory.allocation.cancel`). No new *event* key — Cancel reuses `inventory.stock.released` with `reason: 'order-cancelled'`.
- `@MessagePattern(ROUTING_KEYS.INVENTORY_ALLOCATION_CANCEL)` handler stub in `stock.controller.ts`.
- Appended section in doc `05-allocate-on-place.md`.

**Out:**

- The retail/`epic-08`-side caller (Cancel Order → this RPC) — `epic-08`.
- Commit Sale and its reversal — `epic-08`.
- A new event routing key — reuse `inventory.stock.released`.

## Cancel Allocation — shape

```ts
public async execute(cmd: CancelAllocationCommand): Promise<CancelAllocationResult> {
  const cancelled = await this.stockCache.withInvalidation(
    () => this.tx.runInTransaction(async (scope) => {
      const lines: CancelledLine[] = [];
      for (const line of cmd.lines) {
        const stockLocationId = line.stockLocationId ?? 'default-warehouse';
        // Reverse the allocation: allocatedDelta negative, reservedDelta zero.
        await this.stock.adjustAllocated(
          { variantId: line.variantId, stockLocationId, reservedDelta: 0, allocatedDelta: -line.quantity },
          scope,
        );
        await this.movements.append(
          StockMovement.record({
            variantId: line.variantId, stockLocationId,
            type: StockMovementTypeEnum.Release, quantity: -line.quantity,
            referenceType: 'order', referenceId: cmd.orderId, reasonCode: 'order-cancelled',
          }), scope,
        );
        lines.push({ variantId: line.variantId, stockLocationId, quantity: line.quantity });
      }
      return lines;
    }),
    (lines) => lines.map((l) => ({ variantId: l.variantId, stockLocationId: l.stockLocationId })),
    { correlationId: cmd.correlationId },
  );

  for (const l of cancelled) {
    await this.events.publishStockReleased({
      variantId: l.variantId, stockLocationId: l.stockLocationId, quantity: l.quantity,
      cartIdOrOrderId: cmd.orderId, reason: 'order-cancelled', correlationId: cmd.correlationId,
    });
    await this.events.publishStockMovementRecorded({ /* echo the release movement */ });
  }
  return { cancelled };
}
```

Notes:

- **Cancel Allocation does NOT restore `quantityReserved`.** A cancelled order's lines were `committed` (allocated), not held — they go back to free `quantityOnHand`-backed availability directly (`available = onHand − allocated − reserved` rises because `allocated` falls). It does not re-create reservations.
- The `release` movement uses `referenceType: 'order'` (vs Release Reservation's `'cart'`) — the polymorphic reference distinguishes the two release sources in the audit timeline.
- `adjustAllocated` with `allocatedDelta: -n` never violates a non-negative invariant (cancelling reduces allocation); the `WHERE version = ?` OCC token still applies, with the same retry-then-surface policy.

## RPC handler stub

`stock.controller.ts` gets a real handler bound to the use case — it is a "stub" only in the sense that **no in-repo caller invokes it yet** (`epic-08`'s Cancel Order is the future caller). The handler itself is fully functional:

```ts
@MessagePattern(ROUTING_KEYS.INVENTORY_ALLOCATION_CANCEL)
public async cancelAllocation(@Payload() payload: ICancelAllocationPayload): Promise<CancelAllocationResult> {
  // Inline correlationId — assign() throws outside request scope (ADR-001/ADR-011).
  this.logger.info({ correlationId: payload.correlationId, orderId: payload.orderId }, 'inventory.allocation.cancel received');
  return this.cancelAllocation.execute({ ...payload });
}
```

The wire payload `ICancelAllocationPayload` lives in `libs/contracts/inventory/` so `epic-08`'s caller imports the same shape (drift fails TypeScript on both ends — the ADR-013 contract-test discipline).

## Files to add

- `…/application/use-cases/cancel-allocation.use-case.ts` + `…/spec/cancel-allocation.use-case.spec.ts`
- `…/application/dto/{cancel-allocation.command,cancel-allocation.result}.ts`
- `libs/contracts/inventory/cancel-allocation.payload.ts` (RPC request/response contract)

## Files to modify

- `…/presentation/stock.controller.ts` — the `@MessagePattern(ROUTING_KEYS.INVENTORY_ALLOCATION_CANCEL)` handler.
- `…/infrastructure/stock.module.ts` — register `CancelAllocationUseCase`.
- `libs/messaging/routing-keys.constants.ts` — add `INVENTORY_ALLOCATION_CANCEL` (`inventory.allocation.cancel`).
- `libs/contracts/inventory/index.ts` — export `ICancelAllocationPayload`.
- `docs/implementation/07-inventory-reservation-and-stock-movement/05-allocate-on-place.md` — append the Cancel-Allocation reversal section (task-04 wrote the Place→Allocate half).

## Files to delete

None.

## Tests

`cancel-allocation.use-case.spec.ts`:

- Cancel one line → `quantityAllocated -= n`; `quantityReserved` unchanged; one `release` StockMovement (`referenceType:'order'`, `reasonCode:'order-cancelled'`); `publishStockReleased` once with `reason:'order-cancelled'`.
- Cancel multiple lines in one call → all reversed inside one transaction; the spec asserts `appendMany`/repeated `append` calls and a single `withInvalidation` wrap.
- OCC retry: `adjustAllocated` throws `OccConflictError` once then succeeds → two attempts.

## Doc deliverable — appended to `05-allocate-on-place.md`

Append a **Cancel Allocation (reversal)** section (~30 lines):

1. **What Cancel reverses.** `quantityAllocated -= n` back to free availability; a `release` movement; `StockReleased` with `reason:'order-cancelled'`.
2. **Why it does NOT restore a reservation.** Cancelled lines were committed, not held — they return to `quantityOnHand`-backed availability directly. No reservation is re-created.
3. **The RPC stub for `epic-08`.** The handler is functional today; `epic-08`'s Cancel Order is the future caller; the `ICancelAllocationPayload` contract is shared so the wire can't drift.
4. **Why `release` (not a new movement type).** The ledger already has `release` for "stock returning to availability"; the polymorphic `referenceType` (`'order'` vs `'cart'`) distinguishes a cancelled allocation from a released reservation.

## Carryover produced (consumed by task-06 onward)

- `CancelAllocationUseCase` reachable over `inventory.allocation.cancel` (handler functional; no in-repo caller until `epic-08`).
- `ICancelAllocationPayload` contract exported.
- `INVENTORY_ALLOCATION_CANCEL` routing key.
- Doc `05-allocate-on-place.md` now carries both the Place→Allocate and the Cancel sections.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `cancel-allocation.use-case.spec.ts` green.
- [ ] `yarn build` succeeds; the `@MessagePattern(inventory.allocation.cancel)` handler registers at boot.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `05-allocate-on-place.md` carries the appended Cancel-Allocation section.
