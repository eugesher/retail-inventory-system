---
epic: epic-07
task_number: 6
title: Receive Stock + Adjust Stock now write StockMovement rows
depends_on: [01, 02, 03, 04, 05]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/07-receive-adjust-now-write-movements.md
---

# Task 06 — Receive/Adjust write StockMovement rows (close the epic-04 gap)

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-012](../../../docs/adr/012-stock-aggregate-and-port-adapter.md) — the existing `receive-stock` / `adjust-stock` use cases this task extends.
  - [ADR-023](../../../docs/adr/023-cache-invalidate-post-commit-by-type.md) — Receive/Adjust already route through `withInvalidation`; the StockMovement append joins the same transaction.
  - [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) — the movement insert and the StockLevel UPDATE commit atomically (one transaction).
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — `PinoLogger`; the existing Pino log lines stay, the movement row is *additional*.

## Goal

Close the deferral `epic-04` left explicit: the **Receive Stock** and **Adjust Stock** use cases now also write a `StockMovement` row (`receipt` and `adjustment` respectively) **inside the same transaction** that mutates `stock_level.quantityOnHand`. Today (post-`epic-04`) those operations only emit Pino log lines + the `inventory.stock.received` / `inventory.stock.adjusted` events; the audit ledger had no row. This task adds the ledger write so `/api/inventory/variants/:id/movements` (task-09) returns a complete timeline.

This is the smallest behavioral change in the epic — both use cases already have a transaction and a `withInvalidation` wrapper from `epic-04`; this task injects `STOCK_MOVEMENT_REPOSITORY` and appends one row per operation, then emits `inventory.stock-movement.recorded` post-commit.

## Entry state assumed

Tasks 01–05 carryover present:

- `receive-stock.use-case.ts` + `adjust-stock.use-case.ts` exist from `epic-04`, each wrapping a transaction in `stockCache.withInvalidation` and emitting `publishStockReceived` / `publishStockAdjusted`.
- `STOCK_MOVEMENT_REPOSITORY` (`append`) exists (task-02).
- `IStockEventsPublisherPort.publishStockMovementRecorded` exists (task-03).
- `StockMovement.record(...)` enforces the sign rules (task-02): `receipt` positive-only; `adjustment` genuinely signed.

## Scope

**In:**

- Modify `…/application/use-cases/receive-stock.use-case.ts` — inject `STOCK_MOVEMENT_REPOSITORY`; inside the existing transaction, after the `incrementOnHand`, `append` a `receipt` movement (positive quantity, `actorId` = the staff user, `reasonCode` from the command, `referenceType`/`referenceId` null — a receipt has no external reference unless a PO id is supplied). Emit `publishStockMovementRecorded` post-commit.
- Modify `…/application/use-cases/adjust-stock.use-case.ts` — same shape, `adjustment` movement (signed quantity = the delta, `reasonCode` is **required** for an adjustment per the `epic-04` contract).
- Update the two specs to assert the movement is appended inside the transaction and the event is emitted.
- Doc deliverable `07-receive-adjust-now-write-movements.md`.

**Out:**

- No new routing key (reuses `inventory.stock.received` / `…adjusted` from `epic-04` + `inventory.stock-movement.recorded` from task-03).
- No schema change (the table exists from task-02).
- The audit read endpoint — task-09.

## Receive Stock — the added lines

The existing use case already does (roughly): `withInvalidation(() => runInTransaction(scope => { const level = await stock.incrementOnHand({ variantId, stockLocationId, amount }, scope); return level; }), resolveItems, opts)` then `publishStockReceived(...)`. Add the movement append inside the same callback:

```ts
const level = await this.stock.incrementOnHand(
  { variantId: cmd.variantId, stockLocationId, amount: cmd.quantity }, scope,
);
const movement = await this.movements.append(
  StockMovement.record({
    variantId: cmd.variantId,
    stockLocationId,
    type: StockMovementTypeEnum.Receipt,
    quantity: cmd.quantity,            // positive — Receipt is positive-only
    reasonCode: cmd.reasonCode ?? null,
    referenceType: cmd.referenceType ?? null,  // e.g. 'purchase-order' if supplied
    referenceId: cmd.referenceId ?? null,
    actorId: cmd.actorId ?? null,
  }),
  scope,
);
return { level, movement };
```

Then post-commit:

```ts
await this.events.publishStockReceived({ /* unchanged epic-04 payload */ });
await this.events.publishStockMovementRecorded({ /* echo the receipt movement row */ });
```

## Adjust Stock — the added lines

```ts
const level = await this.stock.applySignedDelta(
  { variantId: cmd.variantId, stockLocationId, delta: cmd.delta, reasonCode: cmd.reasonCode }, scope,
);
const movement = await this.movements.append(
  StockMovement.record({
    variantId: cmd.variantId,
    stockLocationId,
    type: StockMovementTypeEnum.Adjustment,
    quantity: cmd.delta,               // signed — Adjustment can correct up or down
    reasonCode: cmd.reasonCode,        // required for adjustments
    actorId: cmd.actorId ?? null,
  }),
  scope,
);
return { level, movement };
```

- `cmd.delta` is signed; `StockMovement.record` allows either sign for `adjustment` but rejects `0` (a zero adjustment is meaningless — the use case should reject it before reaching here, matching `epic-04`'s validation).
- The movement and the `applySignedDelta` UPDATE are in the same `scope` (transaction) — either both commit or both roll back. This is the auditability guarantee: there is never a `quantityOnHand` change without a corresponding ledger row, and never a phantom ledger row for a change that rolled back.

## Files to add

- `docs/implementation/07-inventory-reservation-and-stock-movement/07-receive-adjust-now-write-movements.md`

## Files to modify

- `…/application/use-cases/receive-stock.use-case.ts` — inject `STOCK_MOVEMENT_REPOSITORY`; append the `receipt` movement; emit `publishStockMovementRecorded`.
- `…/application/use-cases/adjust-stock.use-case.ts` — inject `STOCK_MOVEMENT_REPOSITORY`; append the `adjustment` movement; emit `publishStockMovementRecorded`.
- `…/application/use-cases/spec/receive-stock.use-case.spec.ts` — assert the `receipt` movement append + the event.
- `…/application/use-cases/spec/adjust-stock.use-case.spec.ts` — assert the `adjustment` movement append + the event; a `0` delta is still rejected.
- `…/application/dto/*` — extend the Receive command with optional `referenceType`/`referenceId`/`actorId` if not already present; both commands carry `actorId` (the staff user id from the gateway).
- `…/infrastructure/stock.module.ts` — ensure `STOCK_MOVEMENT_REPOSITORY` is visible to both use cases (it is bound in task-02; just confirm the providers list).

## Files to delete

None.

## Tests

`receive-stock.use-case.spec.ts` (updated):

- Happy path now also asserts: exactly one `receipt` StockMovement appended with the positive quantity inside the transaction callback; `publishStockMovementRecorded` called once post-commit; the existing `publishStockReceived` assertion still holds.
- The movement append uses the same `scope` as `incrementOnHand` (assert both received the same fake scope object).

`adjust-stock.use-case.spec.ts` (updated):

- Positive delta → `adjustment` movement with positive quantity; negative delta → negative quantity.
- `0` delta → rejected before any append (no movement, no event).
- The movement and `applySignedDelta` share the transaction scope.

## Doc deliverable — `07-receive-adjust-now-write-movements.md`

Target ~100 lines. Sections:

1. **The epic-04 deferral, closed.** `epic-04` shipped Receive/Adjust with Pino logs + events but no ledger row (the `stock_movement` table didn't exist yet). This task adds the row now that task-02 created the table.
2. **One transaction, two writes.** Why the movement append and the StockLevel UPDATE must share a transaction: auditability requires that a `quantityOnHand` change and its ledger row commit or roll back together — no phantom rows, no silent changes.
3. **Sign per type.** `receipt` is positive-only; `adjustment` is signed (a stock-take can correct up or down). Cross-link doc `02-…`.
4. **References and actor.** `receipt` may carry a `purchase-order` reference if supplied (else null); `adjustment` carries the required `reasonCode`; both carry `actorId` (the staff user) — these are User-triggered, not System, so `actorId` is non-null. Contrast with the System movements (Reserve/Allocate/Release) where `actorId` is null.
5. **What this task did NOT do.** The read endpoint that surfaces the timeline is task-09; no new routing key (reuses the `epic-04` events + `stock-movement.recorded`).

## Carryover produced (consumed by task-07 onward)

- Receive/Adjust write ledger rows; every `quantityOnHand` change now has a `stock_movement` row.
- The Receive command optionally carries `referenceType`/`referenceId`; both commands carry `actorId`.
- Doc `07-receive-adjust-now-write-movements.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the updated `receive-stock` + `adjust-stock` specs assert the movement append + the event.
- [ ] `yarn build` succeeds.
- [ ] A Receive followed by an Adjust produces two `stock_movement` rows (one `receipt`, one `adjustment`) with the correct signs.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `07-receive-adjust-now-write-movements.md` exists with the sections above.
