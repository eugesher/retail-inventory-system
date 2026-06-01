---
epic: epic-07
task_number: 8
title: Wire cart-side reservation RPCs (INVENTORY_RESERVATION_GATEWAY port)
depends_on: [01, 02, 03, 04, 05, 06, 07]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/04-add-to-cart-cross-service-reserve.md
---

# Task 08 — Wire the cart-side reservation RPCs

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-013](../../../docs/adr/013-order-aggregate-and-cross-service-confirm.md) — the existing `INVENTORY_CONFIRM_GATEWAY` port in retail; the new `INVENTORY_RESERVATION_GATEWAY` mirrors it exactly (a port the use case injects; the `ClientProxy` lives only in the adapter).
  - [ADR-008](../../../docs/adr/008-rabbitmq-via-libs-messaging.md) / [ADR-020](../../../docs/adr/020-rabbitmq-as-inter-service-bus.md) — `ClientProxy.send` for the RPCs; `firstValueFrom`; the legacy `inventory.order.confirm` handler is retired.
  - [ADR-009](../../../docs/adr/009-port-adapter-at-the-gateway.md) / [ADR-004](../../../docs/adr/004-adopt-hexagonal-architecture-per-service.md) — the use case injects the port symbol, never `ClientProxy`.
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — `PinoLogger`; inside `@MessagePattern` handlers log `correlationId` inline.

## Goal

Make the retail-microservice cart operations actually reserve/release/allocate inventory across the bus. `epic-05` shipped the cart/order skeleton with no inventory coupling; this task adds a new **`INVENTORY_RESERVATION_GATEWAY` port** (mirroring `epic-13`'s existing `INVENTORY_CONFIRM_GATEWAY`) plus its RMQ adapter, and updates four use cases:

- **Add to Cart** → calls `inventory.reservation.reserve`; on `OUT_OF_STOCK`, the cart write fails and the gateway surfaces `409 OUT_OF_STOCK` with the available count.
- **Change Quantity** → re-reserves at the new quantity (`inventory.reservation.reserve` is idempotent on `(cartId, variantId)`, so it refreshes).
- **Remove from Cart** → calls `inventory.reservation.release`.
- **Place Order** → calls `inventory.reservation.allocate` (commits the cart's active reservations to allocations).

It also **retires the legacy `inventory.order.confirm` RPC handler** (the deprecated stub from `epic-04` task-08) — the confirm flow is now reservation/allocation, so the old handler and its routing-key usage are removed.

## Entry state assumed

Tasks 01–07 carryover present, and `epic-05` merged:

- The inventory RPCs `inventory.reservation.reserve` / `…release` / `…allocate` are live (tasks 03–04).
- The retail-microservice `orders`/`cart` module(s) host the `Add to Cart` / `Remove from Cart` / `Change Quantity` / `Place Order` use cases from `epic-05`.
- `epic-13`/`epic-04`'s `INVENTORY_CONFIRM_GATEWAY` port + `InventoryConfirmRabbitmqAdapter` exist in retail as the pattern to mirror.
- The legacy `inventory.order.confirm` `@MessagePattern` handler still exists in the inventory `stock.controller.ts` as a deprecation stub.

## Scope

**In (retail-microservice):**

- New port `…/cart/application/ports/inventory-reservation.gateway.port.ts` (or under the relevant module) — `IInventoryReservationGatewayPort` + `INVENTORY_RESERVATION_GATEWAY` symbol, with `reserve(...)`, `release(...)`, `allocate(...)`.
- New adapter `…/infrastructure/messaging/inventory-reservation-rabbitmq.adapter.ts` — wraps `ClientProxy.send(ROUTING_KEYS.INVENTORY_RESERVATION_RESERVE, payload)` etc. with `firstValueFrom`; the **only** place holding the inventory `ClientProxy` for reservations.
- Update the four use cases to inject `INVENTORY_RESERVATION_GATEWAY` and call it; translate the inventory `OUT_OF_STOCK` error into the retail domain error the cart controller maps to `409`.
- Updated specs for the four use cases (the gateway port is faked).
- Register the port binding + adapter in the retail module.

**In (inventory-microservice):**

- Remove the legacy `inventory.order.confirm` `@MessagePattern` handler from `stock.controller.ts` and drop the routing-key usage (the constant may stay in `libs/messaging` marked deprecated if other epics reference it; the *handler* and any inventory-side wiring go).

**In (contracts):**

- The reserve/release/allocate RPC request/response shapes in `libs/contracts/inventory/` (some added in tasks 03–04; ensure the retail adapter imports the same shapes — drift fails TypeScript on both ends).

**Out:**

- The api-gateway HTTP endpoints' *signatures* are unchanged (`epic-05` shipped them); only the downstream behavior changes. The new movements-audit + ops-release endpoints are task-09.
- The cart-abandonment release-all trigger's *scheduling* (a TTL/cron) — `epic-14`; this task wires the manual release-all path (Remove-all / explicit abandon).

## The `INVENTORY_RESERVATION_GATEWAY` port

```ts
export const INVENTORY_RESERVATION_GATEWAY = Symbol('INVENTORY_RESERVATION_GATEWAY');

export interface IReserveResult { reservationId: string; expiresAt: string; status: string; }
export interface IReleaseResult { released: string[]; }
export interface IAllocateResult { allocated: { variantId: number; stockLocationId: string; quantity: number }[]; }

export interface IInventoryReservationGatewayPort {
  reserve(input: {
    variantId: number; stockLocationId?: string; quantity: number; cartId: string; correlationId?: string;
  }): Promise<IReserveResult>;

  release(input: { cartId: string; variantId?: number; reason: string; correlationId?: string }): Promise<IReleaseResult>;

  allocate(input: { cartId: string; orderId: string; correlationId?: string }): Promise<IAllocateResult>;
}
```

The adapter is the mirror of `InventoryConfirmRabbitmqAdapter`:

```ts
@Injectable()
export class InventoryReservationRabbitmqAdapter implements IInventoryReservationGatewayPort {
  constructor(@Inject(MicroserviceClientTokenEnum.Inventory) private readonly client: ClientProxy) {}

  public async reserve(input: ReserveInput): Promise<IReserveResult> {
    return firstValueFrom(this.client.send(ROUTING_KEYS.INVENTORY_RESERVATION_RESERVE, input));
  }
  // release / allocate analogous.
}
```

## Use-case wiring

**Add to Cart** (after the cart-line persistence, or before — match `epic-05`'s ordering; the reserve must succeed for the line to be considered added):

```ts
try {
  const r = await this.inventoryReservation.reserve({
    variantId: line.variantId, quantity: line.quantity, cartId: cart.id, correlationId: cmd.correlationId,
  });
  // attach r.reservationId / r.expiresAt to the line view if epic-05's DTO carries them
} catch (err) {
  if (isOutOfStock(err)) {
    throw new CartLineOutOfStockError(line.variantId, availableFrom(err)); // mapped to 409 OUT_OF_STOCK at the gateway
  }
  throw err;
}
```

- **Change Quantity** → `reserve(...)` with the new quantity (idempotent refresh).
- **Remove from Cart** → `release({ cartId, variantId: line.variantId, reason: 'cart-removed' })`.
- **Place Order** → after the order aggregate is persisted, `allocate({ cartId, orderId })`. If allocate fails (`OUT_OF_STOCK` because a reservation expired and the fallback couldn't cover it), the place fails and the order is not confirmed — follow `epic-05`'s existing failure semantics (the order may be left in a `pending`/failed state, or the placement rolls back — match the existing pattern).

> **Compensation note.** This epic does not add a transactional outbox or a saga coordinator (that hardening is out of scope). The reserve-then-persist-cart-line ordering means a reserve that succeeds but a cart write that then fails leaves a reservation that the TTL sweeper (`epic-14`) eventually reclaims — acceptable under the "reservations are TTL-bounded" contract. Document this explicitly so a reviewer doesn't mistake it for a bug.

## Files to add

- `apps/retail-microservice/.../application/ports/inventory-reservation.gateway.port.ts`
- `apps/retail-microservice/.../infrastructure/messaging/inventory-reservation-rabbitmq.adapter.ts`
- `apps/retail-microservice/.../domain/errors/cart-line-out-of-stock.error.ts` (if no equivalent exists)
- `docs/implementation/07-inventory-reservation-and-stock-movement/04-add-to-cart-cross-service-reserve.md`

## Files to modify

- The four `epic-05` use cases (`add-to-cart`, `change-quantity`, `remove-from-cart`, `place-order`) — inject `INVENTORY_RESERVATION_GATEWAY`; call reserve/release/allocate; translate `OUT_OF_STOCK`.
- Their specs — fake the reservation gateway; assert the calls + the `OUT_OF_STOCK` translation.
- The retail module(s) — bind `INVENTORY_RESERVATION_GATEWAY → InventoryReservationRabbitmqAdapter`; ensure the inventory `ClientProxy` (`MicroserviceClientInventoryModule`) is imported.
- `apps/inventory-microservice/.../presentation/stock.controller.ts` — **remove** the legacy `inventory.order.confirm` handler.
- `libs/contracts/inventory/*` — ensure the reserve/release/allocate request/response shapes are exported and imported by the retail adapter.
- (If the api-gateway cart controller needs to map the new `OUT_OF_STOCK` error to `409` — add/confirm the exception filter mapping.)

## Files to delete

- The legacy `inventory.order.confirm` handler body (and any now-dead `confirmOrder` use case in inventory if it was only the deprecation stub). Do **not** delete the `INVENTORY_ORDER_CONFIRM` constant if other epics still reference it — leave it marked deprecated in `libs/messaging` and remove only the inventory-side handler + retail-side caller.

## Tests

Updated use-case specs (faked `INVENTORY_RESERVATION_GATEWAY`):

- **Add to Cart happy path:** `reserve` called with `{variantId, quantity, cartId}`; the line is added; the reservation id is attached if the DTO carries it.
- **Add to Cart OUT_OF_STOCK:** the fake gateway throws `OUT_OF_STOCK` → the use case throws `CartLineOutOfStockError` (gateway maps to `409`); the cart line is **not** added.
- **Change Quantity:** `reserve` called with the new quantity (idempotent refresh path).
- **Remove from Cart:** `release({ cartId, variantId, reason: 'cart-removed' })` called.
- **Place Order:** `allocate({ cartId, orderId })` called after the order persists; an allocate failure fails the placement per `epic-05`'s semantics.

## Doc deliverable — `04-add-to-cart-cross-service-reserve.md`

Target ~140 lines. Sections:

1. **The RPC seam.** Cart (retail) → Reservation (inventory) over `inventory.reservation.reserve`/`…release`/`…allocate`. Why a port (`INVENTORY_RESERVATION_GATEWAY`), mirroring `INVENTORY_CONFIRM_GATEWAY` — the use case is unit-testable without RabbitMQ; the `ClientProxy` lives only in the adapter (ADR-009/ADR-013).
2. **Add to Cart now reserves.** The behavior change; the `OUT_OF_STOCK` → `409` translation with the available count; the idempotent refresh on Change Quantity.
3. **Remove releases; Place allocates.** The four-operation mapping; the `reason` codes on release (`'cart-removed'`).
4. **No saga / outbox — TTL is the safety net.** The reserve-then-persist ordering; an orphaned reservation from a partial failure is reclaimed by the `epic-14` sweeper because every reservation is TTL-bounded. Why this is acceptable for this epic and what `epic-12` adds (idempotency keys).
5. **Retiring `inventory.order.confirm`.** Why the legacy confirm RPC is gone (the confirm flow is now reservation/allocation); the constant stays deprecated for any lingering reference; the inventory handler + retail caller are removed.
6. **Correlation propagation.** `correlationId` flows from the gateway HTTP request through the cart use case into every reservation RPC payload (ADR-001) so a single trace spans gateway → retail → inventory.
7. **What this task did NOT do.** The audit/ops endpoints (task-09); the cache key bump (task-10); the e2e proof (task-11).

## Carryover produced (consumed by task-09 onward)

- `INVENTORY_RESERVATION_GATEWAY` port + adapter live in retail; the four cart use cases call inventory across the bus.
- The legacy `inventory.order.confirm` handler is retired.
- Add-to-cart on an out-of-stock variant fails with a `409`-mappable error.
- Doc `04-add-to-cart-cross-service-reserve.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`); the use cases inject the port, not `ClientProxy` (boundaries rule honored).
- [ ] `yarn test:unit` passes; the four updated cart use-case specs green, including the `OUT_OF_STOCK` translation.
- [ ] `yarn build` succeeds; the reserve/release/allocate contracts compile on both retail (caller) and inventory (handler) sides.
- [ ] The inventory `stock.controller.ts` no longer registers an `inventory.order.confirm` handler.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `04-add-to-cart-cross-service-reserve.md` exists with the sections above.
