---
epic: epic-07
task_number: 7
title: Transfer Stock use case + endpoint (two-movement atomic transaction)
depends_on: [01, 02, 03, 04, 05, 06]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/08-transfer-stock-two-movements.md
---

# Task 07 — Transfer Stock (two movements, one transaction)

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-012](../../../docs/adr/012-stock-aggregate-and-port-adapter.md) — Transfer is a new use case in the existing `stock` module; per-location `stockLocationId` is already on `stock_level`.
  - [ADR-023](../../../docs/adr/023-cache-invalidate-post-commit-by-type.md) — Transfer invalidates **both** affected locations post-commit.
  - [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) — both StockLevel UPDATEs + both movement inserts in one transaction.
  - [ADR-009](../../../docs/adr/009-port-adapter-at-the-gateway.md) / [ADR-010](../../../docs/adr/010-jwt-rbac-at-the-gateway.md) — the gateway endpoint; `@RequiresPermission(INVENTORY_TRANSFER)`; the port-and-adapter split (controller injects a port, not `ClientProxy`).
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — `PinoLogger`; inline `correlationId` in the RMQ handler.

## Goal

Implement **Transfer Stock** (User; `inventory:transfer`): move `quantity` units of a variant from `fromLocationId` to `toLocationId` in one transaction, recording **two** `StockMovement` rows — a negative `adjustment`-style movement at the source and a positive one at the destination — and updating both `stock_level` rows. In-transit modeling (treating the in-flight units as a third pseudo-location) is deferred to `epic-15`'s Exclusions Register; this epic does an instantaneous source→destination move.

This task also adds the **api-gateway endpoint** `POST /api/inventory/variants/:variantId/stock/transfer` (the inventory module's first write endpoint of the epic), gated by `inventory:transfer`, going through the existing `INVENTORY_GATEWAY_PORT` pattern (controller → use case → RMQ adapter; never a raw `ClientProxy` in the controller).

> **Movement type choice.** A transfer is modeled as a pair of `adjustment` movements (signed: `-n` at source, `+n` at destination) rather than a new `transfer` enum value — the epic's `StockMovementTypeEnum` has no `transfer` member, and the polymorphic `referenceType: 'transfer'` + a shared `referenceId` (a generated transfer id) ties the two rows together for the audit timeline. The two rows share the `referenceId` so "show me this transfer" is one indexed query.

## Entry state assumed

Tasks 01–06 carryover present:

- `IStockRepositoryPort.applySignedDelta` (from `epic-04`) and `STOCK_MOVEMENT_REPOSITORY.appendMany` (task-02) exist.
- `stock_level` has per-location rows; the `default-warehouse` is auto-provisioned; a second location can exist (epic-04's `stock_location` table).
- The api-gateway `modules/inventory/` exists with `INVENTORY_GATEWAY_PORT` + `InventoryRabbitmqAdapter` (rewritten in `epic-04` task-09 to be variant-keyed).
- `PermissionCodeEnum` exists; `INVENTORY_TRANSFER` is **added in this task** (the seed into `warehouse-staff` is task-13).

## Scope

**In (inventory-microservice):**

- `…/application/use-cases/transfer-stock.use-case.ts` + spec.
- DTOs: `…/application/dto/{transfer-stock.command,transfer-stock.result}.ts`.
- Routing key `INVENTORY_STOCK_TRANSFER` (RPC; `inventory.stock.transfer`).
- `@MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_TRANSFER)` handler in `stock.controller.ts`.

**In (api-gateway):**

- `apps/api-gateway/src/modules/inventory/presentation/` — add the transfer endpoint to the inventory controller (or a sibling controller), with a request DTO `{ fromLocationId, toLocationId, quantity }`, gated by `@RequiresPermission(PermissionCodeEnum.INVENTORY_TRANSFER)`.
- `…/application/use-cases/transfer-stock.use-case.ts` (gateway-side thin use case) + the port method on `IInventoryGatewayPort` + its `InventoryRabbitmqAdapter` impl.

**In (contracts):**

- `PermissionCodeEnum.INVENTORY_TRANSFER = 'inventory:transfer'` in `libs/contracts/auth/`.
- Wire payload `libs/contracts/inventory/transfer-stock.payload.ts`.

**Out:**

- In-transit-as-separate-location modeling — `epic-15`.
- Multi-location order routing/sourcing — `epic-15` (this epic always reserves/allocates at `default-warehouse`).
- The Kulala `http/inventory.http` entry — task-12. The seed of `inventory:transfer` into `warehouse-staff` — task-13.

## Transfer Stock — transactional shape

```ts
public async execute(cmd: TransferStockCommand): Promise<TransferStockResult> {
  if (cmd.fromLocationId === cmd.toLocationId) {
    throw new InventoryDomainError('Transfer source and destination must differ');
  }
  if (cmd.quantity <= 0) {
    throw new InventoryDomainError('Transfer quantity must be positive');
  }
  const transferId = randomUUID();

  const result = await this.stockCache.withInvalidation(
    () => this.tx.runInTransaction(async (scope) => {
      // Source: signed delta -n; the guarded UPDATE rejects an over-transfer
      // (WHERE quantity_on_hand - n >= available-ish) → zero rows → error.
      await this.stock.applySignedDelta(
        { variantId: cmd.variantId, stockLocationId: cmd.fromLocationId, delta: -cmd.quantity, reasonCode: 'transfer-out' },
        scope,
      );
      // Destination: +n. Auto-init the row if the destination has no StockLevel yet
      // (upsert via incrementOnHand, which the epic-04 repo supports).
      await this.stock.incrementOnHand(
        { variantId: cmd.variantId, stockLocationId: cmd.toLocationId, amount: cmd.quantity },
        scope,
      );
      await this.movements.appendMany([
        StockMovement.record({
          variantId: cmd.variantId, stockLocationId: cmd.fromLocationId,
          type: StockMovementTypeEnum.Adjustment, quantity: -cmd.quantity,
          referenceType: 'transfer', referenceId: transferId, reasonCode: 'transfer-out', actorId: cmd.actorId,
        }),
        StockMovement.record({
          variantId: cmd.variantId, stockLocationId: cmd.toLocationId,
          type: StockMovementTypeEnum.Adjustment, quantity: cmd.quantity,
          referenceType: 'transfer', referenceId: transferId, reasonCode: 'transfer-in', actorId: cmd.actorId,
        }),
      ], scope);
      return { transferId };
    }),
    // Invalidate BOTH locations post-commit.
    () => [
      { variantId: cmd.variantId, stockLocationId: cmd.fromLocationId },
      { variantId: cmd.variantId, stockLocationId: cmd.toLocationId },
    ],
    { correlationId: cmd.correlationId },
  );

  // Emit one stock-movement.recorded per row (two), best-effort.
  return { transferId: result.transferId, quantity: cmd.quantity };
}
```

- **Atomicity is the whole point.** A transfer that decrements the source but fails to increment the destination would leak units. One transaction across both UPDATEs + both inserts guarantees all-or-nothing.
- **Over-transfer guard.** The source `applySignedDelta` uses the `epic-04` guarded UPDATE (`WHERE quantity_on_hand - n >= 0`-style); zero rows ⇒ a domain error mapped to `409`/`422` at the gateway.
- **Destination auto-init.** If the destination has no `stock_level` row, `incrementOnHand` upserts it (the `epic-04` repo's `INSERT … ON DUPLICATE KEY UPDATE`-style behavior on the `(variant_id, stock_location_id)` unique index).
- The two movements share `referenceId = transferId` and `referenceType = 'transfer'` so the audit endpoint (task-09) can return them as a pair.

## Files to add

- `apps/inventory-microservice/.../application/use-cases/transfer-stock.use-case.ts` + `…/spec/transfer-stock.use-case.spec.ts`
- `apps/inventory-microservice/.../application/dto/{transfer-stock.command,transfer-stock.result}.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/transfer-stock.use-case.ts`
- `apps/api-gateway/src/modules/inventory/presentation/dto/transfer-stock.request.dto.ts`
- `libs/contracts/inventory/transfer-stock.payload.ts`
- `docs/implementation/07-inventory-reservation-and-stock-movement/08-transfer-stock-two-movements.md`

## Files to modify

- `apps/inventory-microservice/.../presentation/stock.controller.ts` — `@MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_TRANSFER)` handler.
- `apps/inventory-microservice/.../infrastructure/stock.module.ts` — register `TransferStockUseCase`.
- `apps/api-gateway/src/modules/inventory/presentation/*.controller.ts` — add `POST /api/inventory/variants/:variantId/stock/transfer` gated by `@RequiresPermission(PermissionCodeEnum.INVENTORY_TRANSFER)`.
- `apps/api-gateway/src/modules/inventory/application/ports/*` — add a `transferStock(...)` method to `IInventoryGatewayPort`.
- `apps/api-gateway/src/modules/inventory/infrastructure/messaging/inventory-rabbitmq.adapter.ts` — implement `transferStock` (the only place holding `ClientProxy`).
- `apps/api-gateway/src/modules/inventory/infrastructure/inventory.module.ts` — register the gateway use case.
- `libs/messaging/routing-keys.constants.ts` — add `INVENTORY_STOCK_TRANSFER`.
- `libs/contracts/auth/permission-code.enum.ts` — add `INVENTORY_TRANSFER = 'inventory:transfer'`.
- `libs/contracts/inventory/index.ts` — export the transfer payload.

## Files to delete

None.

## Tests

`transfer-stock.use-case.spec.ts` (inventory-side):

- Happy path: source `quantityOnHand -= n`, destination `+= n`; **two** `adjustment` movements sharing one `referenceId` (`-n` at source, `+n` at destination); both inside one transaction (assert `appendMany` once + same scope).
- `fromLocationId === toLocationId` → rejected; nothing persisted.
- `quantity <= 0` → rejected.
- Over-transfer (source has fewer than `n`) → the guarded `applySignedDelta` reports zero rows → domain error; the transaction rolls back (destination unchanged, no movements).
- Destination has no prior `stock_level` row → it is created with `quantityOnHand = n` (upsert path).

## Doc deliverable — `08-transfer-stock-two-movements.md`

Target ~100 lines. Sections:

1. **The two-movement model.** A transfer is a signed pair of `adjustment` movements (`-n`/`+n`) sharing a `referenceId`, not a new `transfer` enum value. Why: keeps the type set closed; the polymorphic reference ties the pair.
2. **Atomicity.** Both StockLevel UPDATEs + both movement inserts in one transaction — a half-transfer that leaks or duplicates units is structurally impossible.
3. **Over-transfer guard + destination auto-init.** The guarded source UPDATE; the destination upsert.
4. **Both-location cache invalidation.** `resolveItems` returns both `{variantId, stockLocationId}` pairs so `withInvalidation` fans out to both keys post-commit.
5. **In-transit deferred.** This epic does an instantaneous move; modeling the in-flight units as a third pseudo-location (with a transfer-order document and receive-at-destination step) is `epic-15`'s Exclusions Register. Note the schema already carries `stockLocationId` everywhere so that retrofit is additive.
6. **RBAC.** `inventory:transfer` is a distinct permission from `inventory:adjust` (a transfer is a controlled cross-location move, not an ad-hoc correction); seeded into `warehouse-staff` in task-13.
7. **What this task did NOT do.** The Kulala entry (task-12), the seed (task-13), multi-location order routing (`epic-15`).

## Carryover produced (consumed by task-08 onward)

- `TransferStockUseCase` reachable over `inventory.stock.transfer`; the gateway endpoint live behind `inventory:transfer`.
- `PermissionCodeEnum.INVENTORY_TRANSFER` exists (seeded in task-13).
- The transfer payload contract exported.
- Doc `08-transfer-stock-two-movements.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `transfer-stock.use-case.spec.ts` green across all cases.
- [ ] `yarn build` succeeds.
- [ ] A transfer of `n` units produces exactly two `adjustment` movements sharing one `referenceId`; source and destination totals are consistent; an over-transfer rolls back entirely.
- [ ] `POST /api/inventory/variants/:id/stock/transfer` without `inventory:transfer` returns `403`.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `08-transfer-stock-two-movements.md` exists with the sections above.
