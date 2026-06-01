---
epic: epic-07
task_number: 9
title: Movements audit endpoint + ops manual-release endpoint
depends_on: [01, 02, 03, 04, 05, 06, 07, 08]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/09-movements-audit-endpoint-and-http-file.md
---

# Task 09 — Movements audit + ops manual-release endpoints

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-009](../../../docs/adr/009-port-adapter-at-the-gateway.md) — the api-gateway inventory module; controller injects `INVENTORY_GATEWAY_PORT`, never `ClientProxy`.
  - [ADR-010](../../../docs/adr/010-jwt-rbac-at-the-gateway.md) — `@RequiresPermission(INVENTORY_READ)` for the audit read; `@RequiresPermission(INVENTORY_ADJUST)` for the manual release.
  - [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) — the paginated read uses the `(variant_id, occurred_at)` index from task-02.
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — `PinoLogger`; inline `correlationId` in the inventory `@MessagePattern` handlers.

## Goal

Expose two new api-gateway HTTP endpoints:

- **`GET /api/inventory/variants/:variantId/movements`** (`bearer + inventory:read`) — a paginated StockMovement audit timeline, with `?page=&pageSize=&type=&from=&to=` filters. Backed by `IStockMovementRepositoryPort.query` (task-02) via a new inventory RPC.
- **`POST /api/inventory/reservations/:reservationId/release`** (`bearer + inventory:adjust`) — manual release for ops/debug, calling the existing `ReleaseReservationUseCase` (task-03) by `reservationId`.

This is the API half of doc `09-…`; task-12 appends the Kulala-file half.

## Entry state assumed

Tasks 01–08 carryover present:

- `IStockMovementRepositoryPort.query(query): Promise<IPage<StockMovement>>` exists (task-02).
- `ReleaseReservationUseCase` accepts `{ reservationId }` (release-one path) (task-03).
- The api-gateway `modules/inventory/` exists with `INVENTORY_GATEWAY_PORT` + `InventoryRabbitmqAdapter` (variant-keyed; `epic-04` task-09 + task-07's transfer addition).
- `PermissionCodeEnum.INVENTORY_READ` / `INVENTORY_ADJUST` exist (`epic-04`).

## Scope

**In (inventory-microservice):**

- `…/application/use-cases/query-movements.use-case.ts` + spec — thin wrapper over `IStockMovementRepositoryPort.query`, returning an `IPage<StockMovementView>`.
- `StockMovementView` DTO (`…/application/dto/stock-movement.view.ts`).
- Routing key `INVENTORY_STOCK_MOVEMENT_QUERY` (RPC; `inventory.stock-movement.query`).
- `@MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_MOVEMENT_QUERY)` handler in `stock.controller.ts`.
- (The manual-release path reuses the existing `inventory.reservation.release` RPC — no new inventory use case; the gateway passes `{ reservationId, reason: 'manual-release' }`.)

**In (api-gateway):**

- `GET /api/inventory/variants/:variantId/movements` controller method + query DTO `ProductMovementsQueryDto` (`page`, `pageSize`, `type?`, `from?`, `to?` with class-validator).
- `POST /api/inventory/reservations/:reservationId/release` controller method.
- `IInventoryGatewayPort` gains `queryMovements(...)` and `releaseReservation(...)`; `InventoryRabbitmqAdapter` implements both.
- Gateway use cases `query-movements.use-case.ts` + `release-reservation.use-case.ts` (thin).

**In (contracts):**

- `libs/contracts/inventory/stock-movement.view.ts` (or `.dto.ts`) — the wire shape returned by the query (echoes the StockMovement row; `occurredAt` as ISO string).
- The movements-query request payload shape.

**Out:**

- The Kulala `http/inventory.http` entries — task-12 (this task documents the shapes the http file will exercise).
- The cache key bump — task-10.

## Endpoint shapes

```ts
// api-gateway inventory controller
@Get('variants/:variantId/movements')
@RequiresPermission(PermissionCodeEnum.INVENTORY_READ)
public async movements(
  @Param('variantId', ParseIntPipe) variantId: number,
  @Query() q: ProductMovementsQueryDto,
  @CurrentUser() user: ICurrentUser,
  @CorrelationId() correlationId: string,
): Promise<IPage<StockMovementDto>> {
  return this.queryMovements.execute({ variantId, ...q, correlationId });
}

@Post('reservations/:reservationId/release')
@RequiresPermission(PermissionCodeEnum.INVENTORY_ADJUST)
@HttpCode(HttpStatus.OK)
public async releaseReservation(
  @Param('reservationId') reservationId: string,
  @CurrentUser() user: ICurrentUser,
  @CorrelationId() correlationId: string,
): Promise<{ released: string[] }> {
  return this.releaseReservationUc.execute({ reservationId, reason: 'manual-release', actorId: user.sub, correlationId });
}
```

- The audit read is staff-only by construction (`inventory:read` is a staff permission; customer tokens carry no `permissions` claim — CLAUDE.md's "code-gated route is staff-only" rule).
- The manual release accepts `reason: 'manual-release'` — extend the `ReleaseReservationCommand` `reason` union (or map it to `'cart-removed'` on the wire if the `inventory.stock.released` payload's `reason` enum is closed; prefer adding `'manual-release'` to the union and the wire enum so the audit trail is honest about why).
- `ProductMovementsQueryDto` validates `page ≥ 1`, `pageSize` 1–100 (default 20), `type` ∈ the enum, `from`/`to` ISO dates; the query use case clamps and forwards to `IStockMovementRepositoryPort.query`.

## Files to add

- `apps/inventory-microservice/.../application/use-cases/query-movements.use-case.ts` + `…/spec/query-movements.use-case.spec.ts`
- `apps/inventory-microservice/.../application/dto/stock-movement.view.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/{query-movements,release-reservation}.use-case.ts`
- `apps/api-gateway/src/modules/inventory/presentation/dto/{product-movements-query.dto,stock-movement.dto}.ts`
- `libs/contracts/inventory/stock-movement.view.ts`
- `docs/implementation/07-inventory-reservation-and-stock-movement/09-movements-audit-endpoint-and-http-file.md`

## Files to modify

- `apps/inventory-microservice/.../presentation/stock.controller.ts` — `@MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_MOVEMENT_QUERY)` handler.
- `apps/inventory-microservice/.../infrastructure/stock.module.ts` — register `QueryMovementsUseCase`.
- `apps/inventory-microservice/.../application/dto/release-reservation.command.ts` — add `'manual-release'` to the `reason` union (and the wire enum in the released event).
- `apps/api-gateway/src/modules/inventory/presentation/*.controller.ts` — the two endpoints.
- `apps/api-gateway/src/modules/inventory/application/ports/*` — `queryMovements` + `releaseReservation` on `IInventoryGatewayPort`.
- `apps/api-gateway/src/modules/inventory/infrastructure/messaging/inventory-rabbitmq.adapter.ts` — implement both.
- `apps/api-gateway/src/modules/inventory/infrastructure/inventory.module.ts` — register the two gateway use cases.
- `libs/messaging/routing-keys.constants.ts` — add `INVENTORY_STOCK_MOVEMENT_QUERY`.
- `libs/contracts/inventory/index.ts` — export the movement view + query payload.

## Files to delete

None.

## Tests

`query-movements.use-case.spec.ts`:

- Forwards `{ variantId, page, pageSize, type?, from?, to? }` to `IStockMovementRepositoryPort.query`; maps the `IPage<StockMovement>` to `IPage<StockMovementView>` (`occurredAt` → ISO string).
- Default pagination applied when `page`/`pageSize` omitted.

E2e coverage for both endpoints lands in task-11 (`inventory-movements-audit.e2e-spec.ts`) — this task's unit test covers the use-case mapping; the gateway-side thin use cases are exercised by the e2e.

## Doc deliverable — `09-movements-audit-endpoint-and-http-file.md` (API half)

Target ~110 lines now (task-12 appends the Kulala half). Sections:

1. **The audit read path.** `GET /…/movements` → `inventory.stock-movement.query` RPC → `IStockMovementRepositoryPort.query` → the `(variant_id, occurred_at)` index. The pagination + filter knobs.
2. **RBAC.** `inventory:read` for the audit (staff-only by construction); `inventory:adjust` for the manual release (a stronger write permission — ops/debug only).
3. **The manual-release endpoint.** Why it exists (ops/debug — free a stuck reservation without waiting for the TTL sweeper); it reuses `ReleaseReservationUseCase` with `reason: 'manual-release'` so the audit trail is honest.
4. **View shape.** The `StockMovementView` fields; `occurredAt` as ISO string; how the polymorphic `referenceType`/`referenceId` lets a reader pivot from a movement to its order/cart/transfer.
5. **What this task did NOT do.** The Kulala file (task-12); the e2e proof (task-11); the cache bump (task-10).

## Carryover produced (consumed by task-10 onward)

- `GET /api/inventory/variants/:id/movements` + `POST /api/inventory/reservations/:id/release` live behind their permissions.
- `inventory.stock-movement.query` RPC + `QueryMovementsUseCase`.
- `'manual-release'` added to the release `reason` union + wire enum.
- Doc `09-…md` exists with the API half.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `query-movements.use-case.spec.ts` green.
- [ ] `yarn build` succeeds.
- [ ] `GET /api/inventory/variants/:id/movements` without `inventory:read` → `403`; `POST /…/reservations/:id/release` without `inventory:adjust` → `403`.
- [ ] A receive/adjust/allocate/release sequence is returned in `occurred_at DESC` order by the audit endpoint (proven fully in task-11's e2e).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `09-movements-audit-endpoint-and-http-file.md` exists with the API-half sections.
