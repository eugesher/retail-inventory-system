---
id: epic-07
title: Inventory production-shape — Reservation (TTL, cartId) + typed StockMovement ledger
source_stages: [production-core]
depends_on: [epic-04, epic-05]
microservices: [api-gateway, inventory-microservice, retail-microservice]
task_subfolder: tmp/tasks/epic-07-inventory-reservation-and-stock-movement/
docs_subfolder: docs/implementation/07-inventory-reservation-and-stock-movement/
---

# Epic 07 — Inventory production-shape — Reservation (TTL, cartId) + typed StockMovement ledger

## Goal

Close the inventory model's production-shape gap and make the no-oversell invariant real. Add the `Reservation` entity (TTL-bounded, cartId-scoped, status enum per Q2/Q9) and the typed `StockMovement` ledger (receipt | adjustment | allocation | sale | release | return with polymorphic `referenceType`/`referenceId`). Wire the cart-side `Add to Cart` operation (from `epic-05`) so it now invokes Reserve Stock as a cross-service RPC; wire the order-side `Place Order` operation so it converts the Cart's active Reservations into an Allocation StockMovement at place-time. Implement the operations the report names: Reserve Stock, Release Reservation, Allocate Stock, Cancel Allocation (Commit Sale and Restock from Return arrive in `epic-08` and `epic-09` respectively). Add the **first concurrent-oversell e2e test**. After this epic, two carts cannot race for the last unit; expired reservations leave a clean trail of `release` StockMovements (the sweeper job that flips expired reservations lands in `epic-14`; the entity + the manual-release endpoint land here).

## In-Scope Entities and Operations

- **Reservation**: `id` (UUID), `variantId`, `stockLocationId`, `quantity` (INT), `cartId` (UUID FK — references `cart.id` in retail-microservice; opaque from inventory's perspective), `expiresAt` (TIMESTAMP), `status` (`active` | `committed` | `released` | `expired`), `createdAt`, `updatedAt`, `version` (INT default 0; OCC token).
- **StockMovement**: `id` (BIGINT), `variantId`, `stockLocationId`, `type` (ENUM: `receipt` | `adjustment` | `allocation` | `sale` | `release` | `return`), `quantity` (INT, signed), `reasonCode` (VARCHAR(64) nullable), `referenceType` (VARCHAR(32) nullable, e.g. `cart` | `order` | `return-request`), `referenceId` (VARCHAR(64) nullable), `actorId` (VARCHAR nullable; null for System), `occurredAt` (TIMESTAMP). **Append-only; never UPDATE; never DELETE.**
- **Operations:**
  - **Reserve Stock** (System; triggered by Add to Cart) — preconditions: `quantityOnHand − quantityAllocated − quantityReserved ≥ requested` (the no-oversell invariant, enforced inside one transaction with OCC on `stock_level.version`). Outcome: new Reservation row in `active` with `expiresAt = now + RESERVATION_TTL_MINUTES`; `stock_level.quantityReserved += n`; emits `StockReserved`. Idempotent on `(cartId, variantId)` — calling with the same `(cartId, variantId)` updates the existing Reservation row (refreshes `expiresAt`, adjusts quantity if changed).
  - **Release Reservation** (System; triggered by Remove from Cart / Change Quantity / cart abandonment / TTL expiry) — Reservation status → `released` or `expired`; `stock_level.quantityReserved -= n`; emits `StockReleased`. (The sweeper job that flips active→expired by wall-clock lives in `epic-14`; this epic ships the manual-release codepath only.)
  - **Allocate Stock** (System; triggered by Place Order) — preconditions: matching active Reservation exists (the common path) OR sufficient unreserved available (fallback). Outcome: Reservation → `committed`; new StockMovement of type `allocation`; `stock_level.quantityAllocated += n`, `stock_level.quantityReserved -= n`; emits `StockAllocated`.
  - **Cancel Allocation** (System; triggered by Cancel Order from `epic-08`) — `stock_level.quantityAllocated -= n`; new StockMovement of type `release`; emits `StockReleased`.
  - **Backfill StockMovement on Receive/Adjust** — the `epic-04` Receive Stock and Adjust Stock operations now also write `StockMovement` rows of type `receipt` and `adjustment` respectively. (Epic-04 deferred this; this epic closes the gap.)
  - **Transfer Stock** (User; `inventory:transfer`) — emits two StockMovements (negative at source, positive at destination); in-transit modeling deferred to Exclusions Register.

## Non-Goals

- **Commit Sale** (the physically-departing stock decrement on fulfillment ship) — owned by `epic-08`.
- **Restock from Return** — owned by `epic-09`.
- **Reservation TTL sweeper background job** — owned by `epic-14`. This epic ships the entity + the manual-release endpoint + the inline TTL check at allocate-time (a Reservation whose `expiresAt < now` cannot be committed; the allocate path either refreshes the reservation if stock is still available or fails the place).
- **Idempotency-key dedupe on Reserve Stock** — owned by `epic-12`.
- **OCC enforcement on Cart** — owned by `epic-12`.
- **Multi-location order routing / sourcing logic** — Exclusions Register (`epic-15`); this epic always reserves/allocates at `default-warehouse`. The architecture supports per-line locations (Reservation, StockMovement, Fulfillment all have `stockLocationId`); only the routing decision is single-location.
- **Lot/batch/serial, expiry/FIFO, bin/aisle/shelf, transfer-order documents, ABC, in-transit-as-separate-location** — Exclusions Register (`epic-15`).

## Architectural Decisions Honored

- **Open Question Q2** — explicit Reservation entity (Saleor/Medusa style). Restated rationale: the Vendure approach (Allocation only at checkout completion) is defensible but does not prevent two carts racing for the last unit before checkout. Modern UX expects "1 left!" and reservation-on-add-to-cart; this epic delivers it.
- **Open Question Q9** — Reservation TTL ~15 minutes (env var `RESERVATION_TTL_MINUTES`, default `15`) with explicit refresh on cart writes; immediate commit on order placement.
- **Cross-Cutting "Concurrency & consistency"** — the no-oversell invariant is enforced atomically. The Reserve Stock transaction does (a) `SELECT … FOR UPDATE` on the `stock_level` row (or relies on the `@VersionColumn` OCC token), (b) checks the available formula, (c) inserts/updates the Reservation row, (d) updates `stock_level.quantityReserved`. Transaction-level isolation: `REPEATABLE READ` (MySQL default) + the OCC token. On version-mismatch, the use case retries up to 3 times then surfaces a `409` to the caller.
- **Cross-Cutting "Event emission"** — `StockReserved`, `StockAllocated`, `StockReleased` are mandatory. This epic emits all three. `StockCommitted` (sale) is added by `epic-08`.
- **Cross-Cutting "Auditability"** — every StockMovement is immutable by construction (append-only). Receive/Adjust now produce StockMovement rows in addition to the Pino log lines.
- **Cross-Cutting "Soft delete vs hard delete"** — Reservation is **live ephemeral** (purged after `released`/`expired` + retention window — purge is a future hardening item); StockMovement is **append-only, never delete**.
- **ADR-008** (dotted routing keys): new keys `inventory.stock.reserved`, `inventory.stock.allocated`, `inventory.stock.released`, `inventory.stock-movement.recorded` (the last is a high-volume catch-all for the audit/event-store consumer).
- **ADR-012** (stock aggregate / port-adapter): the existing `STOCK_REPOSITORY` / `STOCK_CACHE` / `STOCK_EVENTS_PUBLISHER` triple is extended with a new `RESERVATION_REPOSITORY` port (sibling) and the existing `IStockEventsPublisherPort` gains the three new emit methods.
- **ADR-016 + ADR-022** (cache keys + schema version): the `StockLevel` projection cache key version bumps `v2` → `v3` because the cached payload now includes `quantityReserved` semantics that depend on Reservation TTL (the cached value is functionally different even though the field set is the same).
- **ADR-023** (post-commit cache invalidation by type): Reserve Stock and Release Reservation route writes through `stockCache.withInvalidation(...)`. Allocate Stock does the same.
- **ADR-017** (boundaries): no new module; the Reservation aggregate slots into the existing stock module's `domain/`.
- **ADR-019** (TypeORM + MySQL): new tables via migration.
- **ADR-010** (RBAC at the gateway): admin Reservation operations (manual release for ops/debug) behind `inventory:adjust`; the cart-side Add-to-Cart inherits its existing customer gating.

## Persistence Changes

**Added (in inventory-microservice):**

- `reservation` table: `id` (CHAR(36) PK), `variant_id`, `stock_location_id` (FK to `stock_location`), `quantity` (INT), `cart_id` (CHAR(36) — opaque), `expires_at` (TIMESTAMP), `status` (ENUM), `version` (INT default 0), timestamps.
- `stock_movement` table: `id` (BIGINT PK), `variant_id`, `stock_location_id`, `type` (ENUM), `quantity` (INT signed), `reason_code` (VARCHAR(64) nullable), `reference_type` (VARCHAR(32) nullable), `reference_id` (VARCHAR(64) nullable), `actor_id` (VARCHAR(64) nullable), `occurred_at` (TIMESTAMP default CURRENT_TIMESTAMP).

**Indexes & constraints:**

- Unique index on `reservation (cart_id, variant_id, stock_location_id)` (idempotency at this granularity).
- Index on `reservation (expires_at)` and `reservation (status, expires_at)` for the future sweeper (`epic-14`).
- Index on `stock_movement (variant_id, occurred_at DESC)` and `stock_movement (reference_type, reference_id)` for the audit-style read path.
- StockMovement is append-only — no UPDATE/DELETE allowed (enforced by repository + reviewed in `spec/architecture-lint.spec.ts`).
- `@VersionColumn` on Reservation.

## Eventing / Messaging

- **New routing keys** (in `libs/messaging/routing-keys.constants.ts`):
  - `inventory.stock.reserved` — `{ reservationId, variantId, stockLocationId, quantity, cartId, expiresAt, eventVersion: 'v1', correlationId }`.
  - `inventory.stock.allocated` — `{ variantId, stockLocationId, quantity, orderId, reservationIdOptional, eventVersion: 'v1', correlationId }`.
  - `inventory.stock.released` — `{ variantId, stockLocationId, quantity, cartIdOrOrderId, reason: 'cart-removed' | 'expired' | 'order-cancelled', eventVersion: 'v1', correlationId }`.
  - `inventory.stock-movement.recorded` — emitted for **every** StockMovement insert (high-volume); payload echoes the StockMovement row. Consumed by `epic-11`'s event-store.
- **New RPCs** (queue `inventory_queue`, dotted patterns):
  - `inventory.reservation.reserve` — request `{ variantId, stockLocationId?, quantity, cartId }` → response `{ reservationId, expiresAt, status }` or error `OUT_OF_STOCK` (with available count).
  - `inventory.reservation.release` — request `{ cartId, variantId? }` → response `{ released: [...] }`.
  - `inventory.reservation.allocate` — request `{ cartId, orderId }` → response `{ allocated: [...] }` or error.
- **Cart-side consumer wiring (retail-microservice):**
  - `Add to Cart` calls `inventory.reservation.reserve` via a new `INVENTORY_RESERVATION_GATEWAY` port (mirroring the existing `INVENTORY_CONFIRM_GATEWAY` pattern from epic-13's existing ADR).
  - `Remove from Cart` / `Change Quantity` calls `inventory.reservation.release` (or reserve with the new quantity).
  - `Place Order` calls `inventory.reservation.allocate`.
- **Retired:** the legacy `inventory.order.confirm` RPC handler (deprecated stub from `epic-04`) is removed.

## API Surface

**New / modified HTTP endpoints in `api-gateway`:**

| Method | Path | Body / params | Auth | Notes |
|---|---|---|---|---|
| `POST` | `/api/cart/:cartId/lines` | (unchanged signature from `epic-05`) | bearer | **Behavior change**: now reserves stock via the new RPC. Returns `409 OUT_OF_STOCK` with the available count when insufficient stock. |
| `PATCH` | `/api/cart/:cartId/lines/:lineId` | (unchanged) | bearer | **Behavior change**: re-reserve at new quantity. |
| `DELETE` | `/api/cart/:cartId/lines/:lineId` | (unchanged) | bearer | **Behavior change**: releases the reservation. |
| `POST` | `/api/cart/:cartId/place` | (unchanged) | bearer | **Behavior change**: now allocates (commits Reservations to Allocations). |
| `GET` | `/api/inventory/variants/:variantId/movements` | query: `?page=&pageSize=&type=&from=&to=` | bearer + `inventory:read` | paginated StockMovement audit. |
| `POST` | `/api/inventory/reservations/:reservationId/release` | — | bearer + `inventory:adjust` | manual release for ops/debug. |
| `POST` | `/api/inventory/variants/:variantId/stock/transfer` | `{ fromLocationId, toLocationId, quantity }` | bearer + `inventory:transfer` | writes two StockMovements; updates two StockLevel rows in one transaction. |

**Kulala HTTP files** (under `http/`):

- **`http/inventory.http`** — EXTENDED with `/movements`, `/reservations/.../release`, `/stock/transfer`.
- The Reserve/Allocate flow is exercised entirely through the existing `http/cart.http` and `http/order.http` requests (no new public endpoints for those — they're internal RPCs).

## Test Strategy

**Unit tests:**

- `apps/inventory-microservice/src/modules/stock/domain/spec/reservation.model.spec.ts` — TTL invariant, status transitions, version bump.
- `apps/inventory-microservice/src/modules/stock/domain/spec/stock-movement.model.spec.ts` — append-only invariant (no `update` method exposed); signed-quantity rules per type (positive on receipt/return, negative on sale/allocation/release).
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/reserve-stock.use-case.spec.ts` — happy path, OUT_OF_STOCK rejection, idempotency on `(cartId, variantId)`, OCC retry-then-fail.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/release-reservation.use-case.spec.ts`.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/allocate-stock.use-case.spec.ts` — Reservation→committed path; the fallback (no active Reservation but available unreserved stock) path; expired-Reservation rejection.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/cancel-allocation.use-case.spec.ts`.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/transfer-stock.use-case.spec.ts` — two-movement atomicity.
- Updated `receive-stock` + `adjust-stock` specs from epic-04 to assert StockMovement rows now get written.

**E2E tests:**

- `test/cart-reserve-release.e2e-spec.ts`: add-to-cart writes Reservation; change-quantity refreshes it; remove-from-cart releases it; cart-abandonment (status flip) releases all.
- `test/place-order-allocates.e2e-spec.ts`: end-to-end cart→place chain; verify Reservation→committed; verify Allocation StockMovement row appears; verify `quantityAllocated`/`quantityReserved` updated correctly.
- **`test/concurrent-oversell.e2e-spec.ts` — REQUIRED by the report's Stage-2 acceptance criterion.** Test setup: a Variant has `quantityOnHand=1`. Two carts race to add it. Exactly one succeeds; the other gets `OUT_OF_STOCK` with available=0. After the loser releases, the winner places the order; allocation succeeds; final stock state is consistent (no orphaned reservations, no negative quantities, exactly one `allocation` StockMovement row).
- `test/inventory-movements-audit.e2e-spec.ts`: receive/adjust/allocate/release flow produces the expected sequence of StockMovement rows queryable via `/api/inventory/variants/:id/movements`.

**Concurrency tests:** the concurrent-oversell spec above is the canonical case. Additional unit-level concurrency tests in `reserve-stock.use-case.spec.ts` use a fake repository that simulates version-mismatch on the first attempt to assert retry-then-success behavior.

**Seed data required:**

- `RESERVATION_TTL_MINUTES=15` set in `.env.example` and `.env.local`.
- Permission code `inventory:transfer` seeded into `warehouse-staff`.

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/07-inventory-reservation-and-stock-movement/`:

- `01-reservation-aggregate-and-q2-q9.md` — restate Q2 (explicit Reservation) and Q9 (TTL ~15min, refresh on writes, immediate commit on place).
- `02-stock-movement-typed-ledger.md` — types and their signs; polymorphic reference; append-only enforcement.
- `03-no-oversell-invariant-and-occ.md` — the cross-cutting §1 restated; OCC + retry policy; cache invalidation post-commit (ADR-023) preserved.
- `04-add-to-cart-cross-service-reserve.md` — the new RPC seam between retail Cart and inventory Reservation; the `INVENTORY_RESERVATION_GATEWAY` port.
- `05-allocate-on-place.md` — Place Order → Allocate flow; Reservation→committed semantics.
- `06-cache-key-bump-v2-to-v3.md` — version bump rationale (semantic change without field-set change).
- `07-receive-adjust-now-write-movements.md` — closes the epic-04 deferral.
- `08-transfer-stock-two-movements.md`.
- `09-movements-audit-endpoint-and-http-file.md`.
- `10-concurrent-oversell-e2e.md` — how to run and read the canonical concurrency test.

**`README.md` updates required:**

- **System diagram**: add Reservation + StockMovement boxes; show the new RPCs.
- **API → Inventory** section: add the `/movements` and `/reservations/.../release` and `/stock/transfer` endpoints.
- New **Inventory invariants** subsection describing the no-oversell guarantee and the OCC mechanism.
- **Caching → Cache key** updated to `v3`.

**`CLAUDE.md` updates required:**

- Extend **stock module** file-listing with `reservation.entity.ts`, `stock-movement.entity.ts`, the new ports + adapters.
- Update **Message patterns** with the four new keys + the three new RPCs.
- Update **Operational notes** bullet on cross-service events to mention the new reserve/allocate/release chain.
- Update **Cache-key convention** to mention `INVENTORY_STOCK_KEY_VERSION='v3'`.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Add `reservation` table + domain + repository.** Migration; spec asserts no oversell at the aggregate level.
2. **Add `stock_movement` table + domain + repository.** Append-only enforced.
3. **Implement Reserve Stock + Release Reservation use cases** with OCC retry + cache invalidation.
4. **Implement Allocate Stock use case** (Reservation→committed; fallback to direct allocate; rejects expired Reservation).
5. **Implement Cancel Allocation use case** (called via RPC from `epic-08`'s Cancel Order; stub the RPC handler).
6. **Extend Receive Stock + Adjust Stock** to also write StockMovement rows (close epic-04 gap).
7. **Implement Transfer Stock use case + endpoint** (two-movement transaction).
8. **Wire the cart-side RPCs:** new `INVENTORY_RESERVATION_GATEWAY` port + adapter in retail-microservice; update Add/Remove/Change/Place use cases to call it.
9. **Add the `GET /api/inventory/variants/:id/movements` audit endpoint** + the `POST /api/inventory/reservations/:id/release` ops endpoint.
10. **Bump cache key version v2→v3.** Update spec.
11. **Author concurrent-oversell e2e + reserve/release/allocate e2e tests.**
12. **Extend `http/inventory.http`** with the new endpoints.
13. **Seed + docs pass.**

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-04` + `epic-05` complete; the cart/order chain exists but is reservation-free. | `reservation.entity.ts`, mapper, repository, domain spec, migration; `01-…md`. |
| 2 | Task 1 complete. | `stock-movement.entity.ts`, mapper, repository, domain spec, migration; `02-…md`. |
| 3 | Tasks 1–2 complete. | Two use cases + specs; updated `IStockEventsPublisherPort`; updated RMQ publisher; cache-invalidation routing through ADR-023; `03-…md`. |
| 4 | Tasks 1–3 complete. | Allocate use case + spec; `05-…md`. |
| 5 | Tasks 1–4 complete. | Cancel allocation use case + spec + RPC handler stub. |
| 6 | Tasks 1–5 complete. | Updated `receive-stock` + `adjust-stock` use cases + specs; `07-…md`. |
| 7 | Tasks 1–6 complete. | Transfer use case + spec + endpoint; `08-…md`. |
| 8 | Tasks 1–7 complete; retail-microservice cart/place use cases compile against new contracts. | New `INVENTORY_RESERVATION_GATEWAY` port + RMQ adapter in retail-microservice; updated cart use cases; updated specs; `04-…md`. |
| 9 | Tasks 1–8 complete. | Audit endpoint controller + use case; ops release endpoint; `09-…md`. |
| 10 | Tasks 1–9 complete. | `INVENTORY_STOCK_KEY_VERSION='v3'`; legacy prefix entry added; cache spec updated; `06-…md`. |
| 11 | Tasks 1–10 complete. | `test/cart-reserve-release.e2e-spec.ts`, `test/place-order-allocates.e2e-spec.ts`, `test/concurrent-oversell.e2e-spec.ts`, `test/inventory-movements-audit.e2e-spec.ts`; `10-…md`. |
| 12 | Tasks 1–11 complete. | Extended `http/inventory.http`. |
| 13 | All prior tasks complete. | Extended `.env.example`/`.env.local`; updated README + CLAUDE.md; extended architecture-lint fixtures. |

## Exit Criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; ≥9 new specs green.
- [ ] `yarn test:e2e` passes; `test/concurrent-oversell.e2e-spec.ts` is **green and stable across 5 consecutive runs** (the report's Stage 2 acceptance criterion).
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots clean; `reservation` and `stock_movement` tables present.
- [ ] Add-to-cart on a Variant with `quantityOnHand=0` returns `409 OUT_OF_STOCK`.
- [ ] Place Order produces exactly one `allocation` StockMovement per OrderLine; querying `/api/inventory/variants/:id/movements` returns the expected timeline.
- [ ] `redis-cli --scan --pattern 'ris:inventory:stock:v3:*'` shows v3 entries; v2 entries are not written on new code paths.
- [ ] Per-task docs present under `docs/implementation/07-inventory-reservation-and-stock-movement/`.
- [ ] `README.md` System diagram + API + Caching updated; `CLAUDE.md` stock module + message patterns + cache notes updated.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
