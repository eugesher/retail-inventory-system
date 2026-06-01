---
id: epic-08
title: Fulfillment + Ship flow — Fulfillment, FulfillmentLine, Cancel, Commit Sale, ship-triggered capture
source_stages: [production-core]
depends_on: [epic-05, epic-07]
microservices: [api-gateway, retail-microservice, inventory-microservice]
task_subfolder: tmp/tasks/epic-08-fulfillment-and-ship-flow/
docs_subfolder: docs/implementation/08-fulfillment-and-ship-flow/
---

# Epic 08 — Fulfillment + Ship flow — Fulfillment, FulfillmentLine, Cancel, Commit Sale, ship-triggered capture

## Goal

Drive the order chain from `pending`/`authorized` all the way to `delivered`. Add `Fulfillment` (per-shipment, per-StockLocation) and `FulfillmentLine` (which OrderLine quantities are in this shipment, supporting partial + split shipments). Implement the Stage-2 order-management operations the report names: Create Fulfillment, Ship Fulfillment (triggers ship-triggered Capture Payment per Q5 default policy, and Commit Sale RPC into inventory which decrements `quantityOnHand`), Mark Delivered, Cancel Order (pre-fulfillment), Cancel Line. Add the `inventory.stock.committed` event and the corresponding `commit-sale` StockMovement type wiring. After this epic, the system can move an order from placement to delivery, with stock physically decrementing at ship-time and the payment automatically captured at the same point unless an explicit pre-ship capture already happened.

## In-Scope Entities and Operations

- **Fulfillment**: `id`, `orderId`, `stockLocationId` (FK to inventory's stock_location — opaque from retail), `status` (`pending` | `shipped` | `delivered` | `cancelled`), `trackingNumber` (nullable), `carrier` (nullable), `shippedAt` (nullable), `deliveredAt` (nullable), `version` (INT default 0), timestamps.
- **FulfillmentLine**: `id`, `fulfillmentId`, `orderLineId`, `quantity` (INT). Quantity sum across all FulfillmentLines for one OrderLine cannot exceed that OrderLine's `quantity`.
- **Operations:**
  - **Create Fulfillment** (User; `order:fulfill`) — preconditions: Order in `pending`/`confirmed`; Payment in `authorized` (or `captured`); the FulfillmentLines' quantities are addressable from the remaining-unfulfilled portion of each OrderLine. Outcome: Fulfillment in `pending` status; OrderLine.status may flip to `partially-shipped` if any quantity is now in flight.
  - **Ship Fulfillment** (User/System; `order:fulfill`) — Fulfillment → `shipped`; calls `inventory.stock.commit-sale` RPC to decrement `quantityOnHand` and write `sale` StockMovement rows; if `Payment.status='authorized'`, triggers the **ship-triggered Capture Payment** automatically (Q5 default policy); OrderLine.status flips to `shipped` (or stays `partially-shipped` if other lines remain); Order.fulfillmentStatus advances to `partially-shipped` or `shipped`; emits `OrderShipped`.
  - **Mark Delivered** (System; typically a carrier-webhook handler — for this epic exposed as an admin endpoint since carrier integration is OOS) — Fulfillment → `delivered`; if all Fulfillments delivered → Order.status → `delivered`, Order.fulfillmentStatus → `delivered`; emits `FulfillmentDelivered`.
  - **Cancel Order** (User/Customer; policy-gated) — preconditions: NO shipped Fulfillments exist. Outcome: Order.status → `cancelled`; for each OrderLine, calls inventory's Cancel Allocation (which writes a `release` StockMovement and decrements `quantityAllocated`); Payment → `voided` if not captured, else flagged for refund (the refund itself is owned by `epic-09`); emits `OrderCancelled`.
  - **Cancel Line** (User; `order:cancel`) — line-level cancel for unshipped quantity only; proportional allocation release.

## Non-Goals

- **Carrier webhook integration** — out of scope. Mark Delivered is exposed as an admin endpoint; carrier-driven automation is referenced as future work.
- **Shipping rate calculation, carrier label generation, address validation services** — Exclusions Register (`epic-15`).
- **Multi-location sourcing logic** — Exclusions Register (`epic-15`); for this epic, every Fulfillment uses `default-warehouse` unless the request body explicitly sets `stockLocationId`.
- **Returns / Refunds** — owned by `epic-09`. Cancel Order with a captured Payment in this epic flags the Payment for refund (sets a flag on Payment) but does NOT actually issue the refund — `epic-09` consumes the flag.
- **Idempotency-key dedupe on Ship Fulfillment** — owned by `epic-12`. The header is accepted from day one.

## Architectural Decisions Honored

- **Open Question Q4** — Order has three orthogonal status fields. Ship Fulfillment advances `fulfillmentStatus`; Cancel Order advances `status`; Capture Payment advances `paymentStatus`. They do NOT collapse into one composite enum.
- **Open Question Q5** — ship-triggered automatic capture is the default policy. The Ship Fulfillment use case checks `Payment.status`: if `authorized`, it calls `PAYMENT_GATEWAY.capture(paymentId)` inline and advances `paymentStatus` to `captured` before committing the transaction. If `captured` already, it just commits the sale.
- **Cross-Cutting "Concurrency & consistency"** — Ship Fulfillment is transactional (Fulfillment + OrderLine status + Payment status all flip in one tx); the cross-service Commit Sale RPC into inventory is invoked AFTER the local commit succeeds, with a retry on transient failure and a poison-letter on hard failure. The Order does NOT require pessimistic locking; OCC on `order.version` is sufficient and is enforced in `epic-12`. The Fulfillment row carries its own `@VersionColumn`.
- **Cross-Cutting "Event emission"** — `FulfillmentShipped` (mapped to routing key `retail.fulfillment.shipped`), `FulfillmentDelivered` (`retail.fulfillment.delivered`), `OrderCancelled` (`retail.order.cancelled`), `StockCommitted` (`inventory.stock.committed`), `PaymentCaptured` (`retail.payment.captured` — already exists from `epic-05`, reused on the ship-triggered path).
- **Cross-Cutting "Auditability"** — every Order status transition and every Payment capture is in the always-audit set. `AUDIT_LOG_PUBLISHER` is invoked at each transition.
- **Cross-Cutting "Soft delete vs hard delete"** — Fulfillment is **append-only / never delete** (cancellation is a state transition).
- **ADR-008** (dotted routing keys): new keys `retail.fulfillment.created/shipped/delivered/cancelled`, `inventory.stock.committed`.
- **ADR-013** (cross-service confirm flow) — the existing pattern (`INVENTORY_CONFIRM_GATEWAY` port + RMQ adapter) is the model for the new `INVENTORY_COMMIT_SALE_GATEWAY` port that Ship Fulfillment uses. Same isolation rules (`ClientProxy` confined to `infrastructure/messaging/`).
- **ADR-016 + ADR-022** (cache keys): no version bump on inventory cache — the StockLevel payload shape is unchanged (only the `quantityOnHand` value moves). Cache invalidation continues to route through ADR-023.
- **ADR-019** (TypeORM + MySQL): new tables via migration.
- **ADR-010** (RBAC): new permission codes `order:fulfill`, `order:cancel` seeded into `warehouse-staff` and `order-support`. Customer can also Cancel Order on their own pending orders (owner-check at the use case).

## Persistence Changes

**Added (in retail-microservice):**

- `fulfillment` table: `id` (BIGINT PK), `order_id` (FK), `stock_location_id` (VARCHAR(64) — opaque), `status` (ENUM), `tracking_number` (VARCHAR(64) nullable), `carrier` (VARCHAR(64) nullable), `shipped_at` (TIMESTAMP nullable), `delivered_at` (TIMESTAMP nullable), `version` (INT default 0), timestamps.
- `fulfillment_line` table: `id`, `fulfillment_id` (FK), `order_line_id` (FK), `quantity` (INT).
- `payment.flagged_for_refund` (BOOL default false) column added — set when Cancel Order finds a captured Payment; consumed by `epic-09`.

**Removed:** none.

**Indexes & constraints:**

- Index on `fulfillment (order_id, shipped_at DESC)`.
- Index on `fulfillment_line (order_line_id)`.
- CHECK (where supported) or application-level: `SUM(fulfillment_line.quantity for an order_line) ≤ order_line.quantity`.
- `@VersionColumn` on Fulfillment.

## Eventing / Messaging

- **New routing keys (`libs/messaging/routing-keys.constants.ts`):**
  - `retail.fulfillment.created` — `{ orderId, fulfillmentId, stockLocationId, lineQuantities: { orderLineId, quantity }[], eventVersion: 'v1', correlationId }`.
  - `retail.fulfillment.shipped` — `{ orderId, fulfillmentId, trackingNumber, carrier, shippedAt, eventVersion: 'v1', correlationId }`.
  - `retail.fulfillment.delivered` — `{ orderId, fulfillmentId, deliveredAt, eventVersion: 'v1', correlationId }`.
  - `retail.order.cancelled` — `{ orderId, cancelledAt, reason, paymentFlaggedForRefund, eventVersion: 'v1', correlationId }`. (Previously reserved; now actually published.)
  - `inventory.stock.committed` — `{ variantId, stockLocationId, quantity, orderId, fulfillmentId, eventVersion: 'v1', correlationId }`. Inventory's `StockMovement` of type `sale` corresponds.
- **New RPC:** `inventory.stock.commit-sale` — request `{ orderId, fulfillmentId, lines: [{ variantId, stockLocationId, quantity }] }` → response `{ committed: [...] }` or error. Retail's Ship Fulfillment use case calls this via a new `INVENTORY_COMMIT_SALE_GATEWAY` port. Idempotent on `(fulfillmentId)`.
- **Notification consumer wiring (inline in this epic):** notification-microservice gets a new consumer for `retail.fulfillment.shipped` and `retail.fulfillment.delivered` to fan out shipment-notifications. (Templated email/SMS arrives in `epic-10`; here the log adapter logs the event.)

## API Surface

**New HTTP endpoints in `api-gateway`** (extending `modules/orders/`):

| Method | Path | Body / params | Auth | Notes |
|---|---|---|---|---|
| `POST` | `/api/orders/:orderId/fulfillments` | `{ stockLocationId?, lines: [{ orderLineId, quantity }] }` | bearer + `order:fulfill` | Create Fulfillment. |
| `POST` | `/api/orders/:orderId/fulfillments/:fulfillmentId/ship` | `{ trackingNumber?, carrier? }`, header `Idempotency-Key` | bearer + `order:fulfill` | Ship + commit sale + ship-triggered capture. |
| `POST` | `/api/orders/:orderId/fulfillments/:fulfillmentId/deliver` | — | bearer + `order:fulfill` | Mark Delivered. |
| `POST` | `/api/orders/:orderId/cancel` | `{ reason? }` | bearer (owner OR `order:cancel`) | Cancel Order (rejected if any Fulfillment is `shipped`). |
| `POST` | `/api/orders/:orderId/lines/:lineId/cancel` | `{ quantity? }` | bearer + `order:cancel` | Cancel Line (unshipped quantity only). |
| `GET` | `/api/orders/:orderId/fulfillments` | — | bearer (owner OR `order:read`) | list. |

**Kulala HTTP files** (under `http/`):

- **`http/fulfillment.http`** — NEW; covers Create / Ship / Mark Delivered / list flow.
- **`http/order-cancel.http`** — NEW; covers Cancel Order pre-fulfillment + Cancel Line cases.

## Test Strategy

**Unit tests:**

- `apps/retail-microservice/src/modules/orders/domain/spec/fulfillment.model.spec.ts` — status transitions; trackingNumber required for `shipped` (configurable — default required); version bump.
- `apps/retail-microservice/src/modules/orders/domain/spec/fulfillment-line.model.spec.ts` — sum-of-quantities invariant per OrderLine.
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/create-fulfillment.use-case.spec.ts` — happy path; over-quantity rejected; partial-ship path.
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/ship-fulfillment.use-case.spec.ts` — calls Commit Sale; calls Capture Payment when `authorized`; idempotent on `(fulfillmentId)`; OrderLine.status correctly flips between `partially-shipped` and `shipped`.
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/mark-delivered.use-case.spec.ts`.
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/cancel-order.use-case.spec.ts` — happy path (no captured Payment → void); captured-Payment path sets `flagged_for_refund`; presence-of-shipped-Fulfillment rejection.
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/cancel-line.use-case.spec.ts`.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/commit-sale.use-case.spec.ts` — new use case in inventory; idempotency on `fulfillmentId`; produces `sale`-type StockMovement; emits `inventory.stock.committed`.

**E2E tests:**

- `test/fulfillment-happy-path.e2e-spec.ts`: place order → create fulfillment → ship → automatic capture happens → delivered. Verify all status transitions, all event emissions, `quantityOnHand` decrement.
- `test/fulfillment-partial-ship.e2e-spec.ts`: 2-line order, two separate Fulfillments split across lines; verify per-line status, Order.fulfillmentStatus = `partially-shipped` until both shipped.
- `test/cancel-order-pre-fulfillment.e2e-spec.ts`: place order (authorize-only) → cancel → Payment voided, allocation released.
- `test/cancel-order-blocked-after-ship.e2e-spec.ts`: place → ship one Fulfillment → attempt cancel → `409`.
- `test/ship-triggers-capture.e2e-spec.ts`: cart→place leaves Payment in `authorized`; ship flips it to `captured` automatically; `retail.payment.captured` event emitted.

**Concurrency tests:** add to the concurrent-oversell suite from `epic-07` a "concurrent ship + cancel" case: a Ship and a Cancel hit the same Order at the same time; exactly one wins; OCC + `version` prevent the other from inverting state.

**Seed data required:**

- Permission codes `order:fulfill`, `order:cancel` seeded.

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/08-fulfillment-and-ship-flow/`:

- `01-fulfillment-aggregate-and-three-statuses.md` — restate Q4; how Order's three statuses interact with Fulfillment's own status.
- `02-create-and-ship-fulfillment.md` — preconditions; partial vs full ship; tracking-number policy.
- `03-ship-triggered-capture-q5.md` — restate Q5; conditional auto-capture; what happens if Capture fails after Commit Sale succeeds (compensating action: Fulfillment.status reverts via a new `pending-with-payment-failure` state OR the operation is wholly rolled back via the saga doc — choose the simpler "block ship until Payment succeeds" in this epic).
- `04-commit-sale-cross-service-rpc.md` — the new `INVENTORY_COMMIT_SALE_GATEWAY` port; idempotency at the RPC layer.
- `05-cancel-order-and-line.md` — preconditions; `flagged_for_refund` flag for the refund epic to consume.
- `06-stockmovement-sale-type.md` — closes the `sale` ledger entry; consumed by audit/event-store later.
- `07-fulfillment-http-files.md`.

**`README.md` updates required:**

- **System diagram**: add Fulfillment + FulfillmentLine; show ship-triggers-capture; show new routing keys.
- **API → Orders** extended with the fulfillment + cancel endpoints.
- **Authentication → Roles** updated for `order:fulfill` and `order:cancel`.

**`CLAUDE.md` updates required:**

- Extend **retail microservice** file-listing with Fulfillment / FulfillmentLine.
- Update **Message patterns** with the five new keys + the new RPC.
- Add **Operational note**: ship-triggered capture is Q5 default; opt-out documented as future work.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Add Fulfillment + FulfillmentLine entities, domain, persistence, mappers, repository.**
2. **Implement Create Fulfillment use case** + e2e setup.
3. **Add `commit-sale.use-case.ts` in inventory** + `inventory.stock.commit-sale` RPC handler + new StockMovement type wiring + `inventory.stock.committed` event.
4. **Add `INVENTORY_COMMIT_SALE_GATEWAY` port + RMQ adapter in retail.**
5. **Implement Ship Fulfillment use case** — calls Commit Sale; auto-Capture Payment when `authorized`; advances all three Order statuses appropriately; emits `retail.fulfillment.shipped` + `retail.payment.captured` (when applicable).
6. **Implement Mark Delivered use case** + endpoint.
7. **Implement Cancel Order + Cancel Line use cases** — calls inventory's Cancel Allocation (from `epic-07`); voids/flags Payment.
8. **Wire api-gateway endpoints** (POST fulfillments / ship / deliver / cancel / cancel line).
9. **Add notification consumers** for `retail.fulfillment.shipped`/`delivered` (log adapter — template rendering comes in `epic-10`).
10. **Author `http/fulfillment.http` + `http/order-cancel.http`.**
11. **Seed + docs pass.**

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-05` + `epic-07` complete. | Fulfillment entities, mappers, repository, domain specs, migration; `01-…md`. |
| 2 | Task 1 complete. | Create Fulfillment use case + spec; `02-…md` (partial). |
| 3 | Tasks 1–2 complete; inventory's StockMovement exists. | New inventory use case + RPC handler; new routing key; spec; `04-…md`, `06-…md`. |
| 4 | Tasks 1–3 complete. | New port + RMQ adapter in retail. |
| 5 | Tasks 1–4 complete. | Ship Fulfillment use case + spec; updated Payment status flow; `02-…md` complete; `03-…md`. |
| 6 | Tasks 1–5 complete. | Mark Delivered use case + spec + endpoint. |
| 7 | Tasks 1–6 complete. | Cancel Order + Cancel Line use cases + specs; `flagged_for_refund` column + migration; `05-…md`. |
| 8 | Tasks 1–7 complete. | api-gateway controller methods + DTOs + pipes. |
| 9 | Tasks 1–8 complete. | Notification consumers for the two new fulfillment events + specs. |
| 10 | Task 8 complete. | `http/fulfillment.http`, `http/order-cancel.http`; `07-…md`. |
| 11 | All prior tasks complete. | Updated seed, README, CLAUDE.md, architecture-lint fixtures. |

## Exit Criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; ≥8 new specs green.
- [ ] `yarn test:e2e` passes; five new e2e files green.
- [ ] Place → Ship → Delivered chain works end-to-end in the seeded environment.
- [ ] `inventory.stock_movement` has a `sale`-type row per shipped line; `stock_level.quantityOnHand` is decremented accordingly.
- [ ] Cancel Order pre-fulfillment voids the Payment; Cancel Order after Capture sets `flagged_for_refund=true` (consumed in `epic-09`).
- [ ] Every request in `http/fulfillment.http` and `http/order-cancel.http` executes end-to-end.
- [ ] Per-task docs present under `docs/implementation/08-fulfillment-and-ship-flow/`.
- [ ] `README.md` System diagram + API updated; `CLAUDE.md` retail + messaging notes updated.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
