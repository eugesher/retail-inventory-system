---
id: epic-05
title: Walking-skeleton order chain — Cart, Order (3-status), OrderLine snapshots, Payment, Address
source_stages: [walking-skeleton]
depends_on: [epic-01, epic-02, epic-03, epic-04]
microservices: [api-gateway, retail-microservice]
task_subfolder: tmp/tasks/epic-05-cart-order-payment-walking-skeleton/
docs_subfolder: docs/implementation/epic-05-cart-order-payment-walking-skeleton/
---

# Epic 05 — Walking-skeleton order chain — Cart, Order (3-status), OrderLine snapshots, Payment, Address

## Goal

Close the Stage-1 chain end-to-end. Rebuild the retail-microservice from scratch as two distinct aggregates in one bounded context: a mutable `Cart` (with `CartLine`) and an immutable `Order` (with `OrderLine`), with one-shot conversion at place-time (Q3). Order carries three orthogonal status fields (Q4): `status` (pending | confirmed | cancelled | shipped | delivered), `paymentStatus` (none | authorized | captured | refunded | failed), `fulfillmentStatus` (unfulfilled | partially-shipped | shipped | delivered). Add `Payment` (gated behind a `PAYMENT_GATEWAY` port with a `FakePaymentGatewayAdapter` default). Add polymorphic `Address` (owner ∈ {Customer, Order}). Snapshot variant `sku`/`nameSnapshot`/`unitPrice`/`taxAmount`/`lineTotal` on every OrderLine at place-time by resolving the catalog's Select Applicable Price (`epic-03`) and the catalog's variant metadata (`epic-02`). Implement the seven Stage-1 operations: Add to Cart, Remove from Cart / Change Quantity, Place Order, Authorize Payment, Capture Payment. Drop the legacy `order`/`order_product`/`customer`/`order_status`/`order_product_status` tables and their entity files. After this epic, a Customer can browse the catalog, build a Cart, place an Order, watch the system Authorize a Payment, and then explicitly Capture it.

## In-Scope Entities and Operations

- **Cart**: `id`, `customerId` (FK; nullable for guest — see Q1/Q7), `currency`, `status` (`active` | `abandoned` | `converted`), `expiresAt`, `version` (forward-looking OCC token, hardened in `epic-12`), timestamps.
- **CartLine**: `id`, `cartId`, `variantId`, `quantity`, `unitPriceSnapshot` (captured at add time; may refresh on cart refresh).
- **Order**: `id`, `orderNumber` (human-facing, immutable; e.g. `ORD-2026-00000001`), `customerId`, `currency` (immutable on the row), `status`, `paymentStatus`, `fulfillmentStatus` (Q4 — three orthogonal fields), `subtotalMinor`, `taxTotalMinor`, `discountTotalMinor` (zero in this epic), `shippingTotalMinor` (zero in this epic), `grandTotalMinor`, `billingAddressId` (snapshot FK), `shippingAddressId` (snapshot FK), `placedAt`, `version`, timestamps.
- **OrderLine**: `id`, `orderId`, `variantId`, `sku` (snapshot), `nameSnapshot`, `quantity`, `unitPriceMinor` (snapshot), `taxAmountMinor`, `discountAmountMinor` (zero here), `lineTotalMinor`, `status` (`allocated` | `shipped` | `partially-shipped` | `cancelled` | `returned`) — defaulting to `allocated` at place-time (real allocation arrives in `epic-07`; here the status field is set proactively for forward compatibility).
- **Payment**: `id`, `orderId`, `amountMinor`, `currency`, `method` (opaque token returned by gateway), `status` (`authorized` | `captured` | `voided` | `refunded` | `failed`), `gatewayReference` (opaque string), `authorizedAt`, `capturedAt` (nullable), timestamps.
- **Address**: `id`, `ownerType` (`customer` | `order`), `ownerId`, `recipientName`, `line1`, `line2`, `city`, `region`, `postalCode`, `country` (2-char ISO), `phone`, timestamps. (Snapshotted on Orders — an Order's `billing_address_id` / `shipping_address_id` rows are immutable copies, not references to the Customer's address book entries.)
- **Operations:**
  - **Add to Cart** (Customer) — appends a CartLine, snapshotting `unitPriceSnapshot` via Select Applicable Price (`epic-03`). Real stock reservation lands in `epic-07`; here Add-to-Cart is a write to the cart only.
  - **Remove from Cart / Change Quantity** (Customer) — mutates a CartLine.
  - **Place Order** (Customer) — converts Cart `active` → `converted`, creates Order in `status=pending`, snapshots OrderLines, snapshots shipping/billing Addresses from the request body (not from the Customer's address book), authorizes Payment via `PAYMENT_GATEWAY` port. Emits `OrderPlaced`. **One-shot conversion** (Q3). Idempotency-key on the request — required from day one per Q10 (the local `idempotency_key` table is added in `epic-12`; here the endpoint accepts and forwards the header but does not yet enforce dedupe — flagged as TODO with a forward link).
  - **Authorize Payment** (System; triggered inline by Place Order; Q5 default policy) — calls `PAYMENT_GATEWAY.authorize(...)`; on success persists Payment in `authorized`, advances `Order.paymentStatus` to `authorized`.
  - **Capture Payment** (System or User; explicit op per Q5) — separate endpoint; calls `PAYMENT_GATEWAY.capture(paymentId)`; advances Payment to `captured`. (Ship-triggered automatic capture lands in `epic-08`.)
  - **Get Order** (Customer; bearer-only on the customer's own orders) — read of an Order header + lines.
  - **List My Orders** (Customer) — paginated list of the authenticated customer's orders.

## Non-Goals

- **Reservation** (cart-time stock hold) — owned by `epic-07`. Until then, Add-to-Cart has no stock-hold semantics.
- **Allocate Stock at place-time** — owned by `epic-07` (which also wires `OrderLine.status='allocated'` to a real allocation rather than a sentinel).
- **Fulfillment, Ship, Mark Delivered** — owned by `epic-08`.
- **Cancel Order / Cancel Line** — owned by `epic-08` (pre-fulfillment) and `epic-09` (post-fulfillment cancel turns into return).
- **Returns, Refunds, Issue Refund** — owned by `epic-09`.
- **Real payment gateway (Stripe/PayPal/etc.)** — Exclusions Register (`epic-15`); this epic ships `FakePaymentGatewayAdapter` (always returns authorized) behind `PAYMENT_GATEWAY` port for future swap.
- **Idempotency-key persistence + dedupe enforcement** — owned by `epic-12`. This epic accepts the header but does not deduplicate.
- **OCC enforcement on Cart** — owned by `epic-12`. The `version` column ships now to make the future retrofit non-destructive.
- **Shipping rate calculation, tax computation, fraud screening, BNPL, B2B quote/PO** — Exclusions Register (`epic-15`).
- **The retail-side `customer` table** — DELETED in this epic. Customer identity lives only in the api-gateway's auth module (per `epic-01`'s default-b decision). The Order references customer by `id` only.

## Architectural Decisions Honored

- **Open Question Q1** — Cart is a persistent entity for authenticated customers. Guests get an ephemeral session-id-keyed Cart that promotes to persistent (linked to a Customer row created with `status='guest'`) on first login or on Place Order. Guest-side promotion: when an unauthenticated client posts to `/api/cart`, the response includes a session cookie + a Cart row tied to a placeholder `Customer.status='guest'` row created on the spot (per Q7). When that customer later registers/logs in, their session-cart converts to their own.
- **Open Question Q2 (forward-looking)** — explicit Reservation entity arrives in `epic-07`. This epic's Add-to-Cart does NOT yet reserve stock; the cart-line's `unitPriceSnapshot` is the only "snapshot at add time" semantic in this epic.
- **Open Question Q3** — Cart and Order are distinct aggregates. One-shot conversion at Place Order time; no post-placement edits to "the cart" can corrupt the order record.
- **Open Question Q4** — separate `status`, `paymentStatus`, `fulfillmentStatus` on Order from day one.
- **Open Question Q5** — authorize on placement, capture on ship is the default policy. Capture is an explicit operation so other policies remain achievable. This epic ships Authorize (auto, inline with Place Order) and Capture (explicit, via `POST /api/order/:id/payments/capture`). The ship-triggered automatic capture is added in `epic-08`.
- **Open Question Q6 (forward-looking)** — Customer is referenced by Order via `customerId`; Q6 tombstone-erase nulls Customer PII while preserving the id. Order rows must continue to resolve after a Customer is erased. This epic ensures Order does NOT denormalize Customer PII onto its own row beyond the snapshotted `Address`.
- **Open Question Q7** — every Order produces a Customer row, including guest orders (status `guest`).
- **Open Question Q10** — idempotency keys are required on `Place Order` and `Capture Payment`. Endpoints accept the `Idempotency-Key` header from day one; dedupe enforcement lands in `epic-12`.
- **Cross-Cutting "Concurrency & consistency"** — Order placement is transactional but does not require pessimistic locking. Cart mutations should be optimistically locked per cart (the `version` column ships now). Payment authorization is naturally idempotent via gateway tokens.
- **Cross-Cutting "Event emission"** — `OrderPlaced`, `PaymentAuthorized`, `PaymentCaptured` are mandatory state-transition events (this epic). `OrderCancelled`, `PaymentRefunded`, `FulfillmentShipped/Delivered`, `ReturnRequested`, `ReturnAuthorized`, `RefundIssued` are emitted by later epics.
- **Cross-Cutting "Auditability"** — every Order status transition and every Payment / Refund is in the always-audit set. The `AUDIT_LOG_PUBLISHER` port (added by `epic-01` as no-op) is invoked at every transition in this epic so the call sites are correct when `epic-11` swaps in the real adapter.
- **Cross-Cutting "Soft delete vs hard delete"** — Order, OrderLine, Payment are **append-only / never delete** (cancellation is a state transition). Cart is **live ephemeral** (periodically purged after `status='abandoned'`).
- **ADR-004 / 009 / 012 / 013** (per-module hexagonal): retail-microservice is reshaped to host two sibling modules (`cart/` and `orders/`) plus a shared `payment/` infrastructure surface for the gateway adapter. Both follow the canonical template.
- **ADR-008** (dotted routing keys): new routing keys `retail.cart.created/updated`, `retail.order.placed/cancelled`, `retail.payment.authorized/captured` added. The legacy `retail.order.created`/`retail.order.confirmed` routing keys are RETIRED (the notification consumer is updated to subscribe to the new key set in `epic-10` and inline in this epic).
- **ADR-016 + ADR-022** (cache keys + schema version): if order reads are later cached, key convention `ris:retail:order:v1:<orderId>` (builder `CACHE_KEYS.retailOrder` already exists in `libs/cache/cache-keys.ts`); constant `RETAIL_ORDER_KEY_VERSION='v1'` already present (no bump). This epic does NOT yet wire any cache on order reads.
- **ADR-017** (boundaries lint): the `cart/` and `payment/` modules are new — added to eslint boundaries + fixture suite.
- **ADR-019** (TypeORM + MySQL): new tables via fresh migration.
- **ADR-010** (RBAC at the gateway): customer endpoints behind `@RequiresPermission('customer:own-orders:read')` for read paths, owner-check at the use case for writes. Admin oversight endpoints under `order:read`. New permission codes: `customer:own-orders:read`.

## Persistence Changes

**Added (in retail-microservice):**

- `cart` table: `id` (UUID PK), `customer_id` (FK to api-gateway's customer.id — opaque), `currency` (CHAR(3)), `status` (ENUM), `expires_at` (TIMESTAMP nullable), `version` (INT default 0), timestamps.
- `cart_line` table: `id` (BIGINT PK), `cart_id` (FK), `variant_id` (INT), `quantity` (INT), `unit_price_snapshot_minor` (BIGINT), `currency_snapshot` (CHAR(3)), timestamps.
- `order` table — **rebuilt from scratch**: `id` (BIGINT PK), `order_number` (VARCHAR(20) unique), `customer_id`, `currency` (CHAR(3)), `status` (ENUM), `payment_status` (ENUM), `fulfillment_status` (ENUM), `subtotal_minor`/`tax_total_minor`/`discount_total_minor`/`shipping_total_minor`/`grand_total_minor` (BIGINT), `billing_address_id` (FK), `shipping_address_id` (FK), `placed_at` (TIMESTAMP), `version` (INT default 0), timestamps.
- `order_line` table — **rebuilt from scratch**: `id`, `order_id`, `variant_id`, `sku`, `name_snapshot`, `quantity`, `unit_price_minor`, `tax_amount_minor`, `discount_amount_minor`, `line_total_minor`, `status` (ENUM), timestamps.
- `payment` table: `id`, `order_id`, `amount_minor`, `currency`, `method` (VARCHAR), `status` (ENUM), `gateway_reference` (VARCHAR), `authorized_at` (TIMESTAMP nullable), `captured_at` (TIMESTAMP nullable), timestamps.
- `address` table: `id` (UUID PK), `owner_type` (ENUM), `owner_id` (VARCHAR), `recipient_name`, `line1`, `line2` (nullable), `city`, `region`, `postal_code`, `country` (CHAR(2)), `phone`, timestamps. Polymorphic via `(owner_type, owner_id)`.

**Removed:**

- Legacy `order`, `order_product`, `order_status`, `order_product_status`, `customer` tables and their entity files in `apps/retail-microservice/src/modules/orders/infrastructure/persistence/`.
- Legacy routing keys `retail.order.create`, `retail.order.confirm`, `retail.order.get`, `retail.order.created`, `retail.order.confirmed`, `retail.order.cancelled` (the last three were reserved-for-future); replaced by the new keys listed under **Eventing**.

**Indexes & constraints:**

- Unique index on `order.order_number`, `cart.id` PK, `payment.gateway_reference`.
- Index on `order (customer_id, placed_at DESC)` for the "list my orders" read.
- Index on `cart_line (cart_id)`, `order_line (order_id)`.
- Polymorphic Address: composite index on `(owner_type, owner_id)`.
- FK `order_line.order_id → order.id ON DELETE RESTRICT` (Orders are append-only).
- `@VersionColumn()` on Cart and Order.

## Eventing / Messaging

- **New routing keys (added to `libs/messaging/routing-keys.constants.ts`):**
  - `retail.cart.created` — payload: `{ cartId, customerId, currency, eventVersion: 'v1', correlationId }`.
  - `retail.cart.line-added` — payload: `{ cartId, variantId, quantity, eventVersion: 'v1', correlationId }`.
  - `retail.cart.line-removed`, `retail.cart.line-quantity-changed` — similar shapes.
  - `retail.order.placed` — payload: `{ orderId, orderNumber, customerId, grandTotalMinor, currency, lineCount, eventVersion: 'v1', correlationId }`. **Replaces** the legacy `retail.order.created`.
  - `retail.payment.authorized` — `{ orderId, paymentId, amountMinor, currency, eventVersion: 'v1', correlationId }`.
  - `retail.payment.captured` — `{ orderId, paymentId, amountMinor, currency, eventVersion: 'v1', correlationId }`.
- **Retired:** the notification microservice's existing `order-events.consumer.ts` (which subscribes to `retail.order.created`) is updated in **task 12** of this epic (not deferred to epic-10) to subscribe to `retail.order.placed`. This keeps the notification chain unbroken across the cluster reshape.
- **Preserved:** the existing `inventory.stock.low` consumer in notification is untouched by this epic.

## API Surface

**New / modified HTTP endpoints in `api-gateway`** (new `modules/cart/` + reshaped `modules/retail/` → renamed `modules/orders/`):

| Method | Path | Body / params | Auth | Response |
|---|---|---|---|---|
| `POST` | `/api/cart` | optional `{ currency }` | bearer (customer) or anonymous (session cookie) | new Cart in `active` |
| `GET` | `/api/cart/:cartId` | — | bearer (owner check) | cart + lines |
| `POST` | `/api/cart/:cartId/lines` | `{ variantId, quantity }` | bearer (owner check) | updated cart |
| `PATCH` | `/api/cart/:cartId/lines/:lineId` | `{ quantity }` | bearer (owner check) | updated cart |
| `DELETE` | `/api/cart/:cartId/lines/:lineId` | — | bearer (owner check) | updated cart |
| `POST` | `/api/cart/:cartId/place` | `{ shippingAddress, billingAddress, paymentMethod }`, **header**: `Idempotency-Key: <uuid>` | bearer | new Order header + Authorize Payment outcome |
| `GET` | `/api/orders/:orderId` | — | bearer (owner OR `order:read`) | order header + lines + payment summary |
| `GET` | `/api/orders` | query: pagination | bearer (customer; lists own only) | list |
| `POST` | `/api/orders/:orderId/payments/capture` | optional `{ amountMinor }`, **header**: `Idempotency-Key: <uuid>` | bearer (`order:capture` OR system) | updated Payment row |

**Removed:** legacy `POST /api/order`, `PUT /api/order/:id/confirm` (replaced by `POST /api/cart/:id/place`). `http/order.http` is rewritten.

**Kulala HTTP files** (under `http/`):

- **`http/cart.http`** — NEW; covers POST create cart, add line, change quantity, remove line, get cart. Header documents the seeded customer login + capturing access token + capturing `cartId`.
- **`http/order.http`** — REWRITTEN; covers POST place-order, GET order, GET orders, POST capture; includes `Idempotency-Key` header in the place + capture requests with a randomized-uuid example.

## Test Strategy

**Unit tests** (domain spec siblings):

- `apps/retail-microservice/src/modules/cart/domain/spec/cart.model.spec.ts` — non-negative quantity, currency immutable post-create, status transitions, version bump on each mutation.
- `apps/retail-microservice/src/modules/cart/domain/spec/cart-line.model.spec.ts` — snapshot stays stable across cart mutations on unrelated lines.
- `apps/retail-microservice/src/modules/orders/domain/spec/order.model.spec.ts` — three status fields evolve independently (e.g. `paymentStatus=captured` while `fulfillmentStatus=unfulfilled` is valid); `currency` immutable; total invariants (`grandTotal = sum(lineTotal) + tax + shipping − discount`).
- `apps/retail-microservice/src/modules/orders/domain/spec/order-line.model.spec.ts` — snapshot invariant: `unitPrice` / `nameSnapshot` / `sku` immutable post-creation.
- `apps/retail-microservice/src/modules/orders/domain/spec/payment.model.spec.ts` — status transitions (`authorized → captured`, `authorized → voided`, etc.); amount non-negative.
- `apps/retail-microservice/src/modules/orders/domain/spec/address.model.spec.ts` — `country` is 2-char ISO, `ownerType` matches one of two enum values.
- Use-case specs: `add-to-cart`, `remove-from-cart`, `change-cart-line-quantity`, `place-order`, `authorize-payment` (via fake gateway), `capture-payment`, `get-order`, `list-my-orders`. Each spec lives at `apps/retail-microservice/src/modules/<cart|orders>/application/use-cases/spec/*.spec.ts`.
- `apps/retail-microservice/src/modules/orders/infrastructure/payment-gateway/spec/fake-payment-gateway.adapter.spec.ts` — adapter contract conformance.

**E2E tests:**

- `test/cart-to-order-walking-skeleton.e2e-spec.ts`:
  1. Customer logs in (via `epic-01` customer-side login).
  2. Customer creates Cart.
  3. Customer adds two CartLines (the two seeded variants).
  4. Customer places the Order with shipping + billing Address; sends an `Idempotency-Key` header.
  5. Response includes `orderNumber`, `status=pending`, `paymentStatus=authorized`, `fulfillmentStatus=unfulfilled`.
  6. Customer fetches the Order — sees snapshot fields (`sku`, `nameSnapshot`, `unitPriceMinor`) populated.
  7. Customer captures the Payment — `paymentStatus=captured`.
  8. Repeat the place call with the same Idempotency-Key — receives the SAME Order id and Payment id (Note: dedupe is a no-op in this epic; the test asserts this is the case and explicitly cites that dedupe lands in `epic-12`).
- `test/guest-cart-promotion.e2e-spec.ts`: anonymous cart → register-and-login → cart still resolves under the new customer.
- `test/order-list-my-orders.e2e-spec.ts`: paginated list, customer can only see their own orders.

**Concurrency tests:** NOT in this epic — cart concurrent-mutation tests land in `epic-12`. Oversell tests land in `epic-07`.

**Seed data required:**

- `scripts/test-db-seed.ts` extended to create one example cart for the seeded customer with one line (sets up the e2e prereqs without seeding the actual e2e flow).
- Permission codes `customer:own-orders:read` and `order:capture` seeded into the appropriate roles (customer auto-gets `customer:*`; admin + order-support get `order:capture`).

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/epic-05-cart-order-payment-walking-skeleton/`:

- `01-retail-rebuild-and-old-tables-dropped.md` — what was deleted, why a full rewrite is cheaper than incremental refactor.
- `02-cart-aggregate-and-q1-q3-decisions.md` — restate Q1 (persistent for auth, ephemeral-promoted for guests) and Q3 (distinct aggregates).
- `03-order-three-status-and-q4-decision.md` — restate Q4; the three orthogonal state machines drawn explicitly.
- `04-order-line-snapshot-and-cross-service-lookup.md` — how Place Order fetches variant metadata + applicable price from catalog at write-time; the snapshot is the contract, not the catalog row.
- `05-payment-gateway-port-and-fake-adapter.md` — why the port-and-adapter split; what the fake returns; how to swap in a real gateway later (link forward to `docs/extensions/dropshipping-vendor-routing.md` is wrong — this links to the fake-adapter docs only; the future real-gateway design sketch sits under `docs/extensions/` after `epic-15`).
- `06-address-polymorphic-snapshot.md` — owner-type discriminator; why Order Addresses are snapshot copies, not references.
- `07-authorize-on-place-capture-explicit-q5.md` — restate Q5; the ship-triggered capture in `epic-08` is referenced.
- `08-idempotency-key-header-q10.md` — restate Q10; the header is accepted now, dedupe enforcement deferred to `epic-12`.
- `09-routing-keys-retired-and-added.md` — table of old vs new keys; the notification consumer update done inline.
- `10-cart-and-order-http-files.md` — `http/cart.http` and rewritten `http/order.http`.

**`README.md` updates required:**

- **System diagram** rewritten: cart + order + payment boxes inside retail; payment-gateway-port called out (with the fake adapter as default); the retired legacy routing keys removed from the diagram.
- **API → Orders** rewritten to cover the new endpoint set.
- **API → Cart** new section.
- New **Payment gateway** subsection under **API** noting the port-and-adapter and the fake default.
- **Authentication → Roles** updated for the `customer:own-orders:read` and `order:capture` codes (cross-link to `epic-01`'s permission section).

**`CLAUDE.md` updates required:**

- **Retail microservice** section rewritten: now hosts `cart/` and `orders/` modules and an infrastructure-side `payment-gateway/` adapter folder. New file-listing snippet.
- **Message patterns** list: remove the four legacy `retail.*` keys; add the seven new ones; note the notification consumer re-pointing.
- **Forbidden imports / boundaries**: confirm `ClientProxy` (and `PAYMENT_GATEWAY` adapter) remain confined to `infrastructure/`.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Drop legacy retail tables + entity files + use cases + controllers.** Compile-clean intermediate (stubs). Migration drops 5 tables.
2. **Add `cart` + `cart_line` tables, domain, persistence, mappers.** No use cases yet — repository contract first.
3. **Add `order` + `order_line` + `address` tables, domain, persistence, mappers.**
4. **Add `payment` table, domain, persistence; introduce `PAYMENT_GATEWAY` port + `FakePaymentGatewayAdapter`.**
5. **Implement Add to Cart / Remove from Cart / Change Quantity / Get Cart use cases + controllers.**
6. **Implement Place Order use case** (cross-service: read variant metadata + applicable price from catalog via the existing `MicroserviceClientCatalogModule` RPCs added in epic-02/03). Snapshot OrderLines + Addresses; persist Order; call `PAYMENT_GATEWAY.authorize`; emit `retail.order.placed` + `retail.payment.authorized`.
7. **Implement Capture Payment use case + endpoint.**
8. **Implement Get Order + List My Orders use cases + endpoints.** Owner-check enforced.
9. **Add api-gateway `modules/cart/` + reshape `modules/retail/` → `modules/orders/`.** Controllers, DTOs, pipes, RMQ adapters.
10. **Author `http/cart.http`; rewrite `http/order.http`.**
11. **Update the notification microservice's `order-events.consumer.ts`** to subscribe to `retail.order.placed` instead of `retail.order.created`. (Inline in this epic — keeps the notification chain unbroken.)
12. **Seed + docs pass:** extend `scripts/test-db-seed.ts`; write the ten `docs/implementation/.../*.md` files; rewrite README + CLAUDE.md sections; extend `spec/architecture-lint.spec.ts`.

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-01` through `epic-04` complete. | Migration dropping legacy tables; deleted entity/use-case/controller files; stub repositories compile; `01-…md`. |
| 2 | Task 1 complete. | New cart entities + mapper + repository + domain spec; migration; `02-…md`. |
| 3 | Tasks 1–2 complete. | New order entities + addresses + domain spec; migration; `03-…md`, `06-…md`. |
| 4 | Tasks 1–3 complete. | New payment entity; new `PAYMENT_GATEWAY` port file under `apps/retail-microservice/src/modules/orders/application/ports/`; `FakePaymentGatewayAdapter` under `infrastructure/payment-gateway/`; `05-…md`. |
| 5 | Tasks 1–4 complete. | Cart use cases + specs + cart controller pieces; `02-…md` (continued). |
| 6 | Tasks 1–5 complete. | Place Order use case + spec; new RMQ publisher (`retail.order.placed`, `retail.payment.authorized`); new RMQ client to catalog for variant + price RPCs; `04-…md`, `07-…md`, `08-…md`, `09-…md` (partial). |
| 7 | Tasks 1–6 complete. | Capture Payment use case + spec + endpoint; new RMQ key `retail.payment.captured`; `07-…md` (complete). |
| 8 | Tasks 1–7 complete. | Get Order + List My Orders use cases + specs + endpoints. |
| 9 | Tasks 1–8 complete. | api-gateway: new `modules/cart/` full hexagonal layout; renamed `modules/orders/` (from `retail/`); controllers + DTOs + pipes. |
| 10 | Task 9 complete. | New `http/cart.http`; rewritten `http/order.http`; `10-…md`. |
| 11 | Task 6 + the consumer module exists. | Updated `apps/notification-microservice/.../order-events.consumer.ts`; new routing keys imported; the consumer use case updated to handle the new payload shape; updated consumer spec. `09-…md` (complete). |
| 12 | All prior tasks complete. | Extended seed; rewritten README sections; rewritten CLAUDE.md sections; extended architecture-lint fixtures. |

## Exit Criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; ≥12 new domain + use-case spec files green.
- [ ] `yarn test:e2e` passes; `test/cart-to-order-walking-skeleton.e2e-spec.ts`, `test/guest-cart-promotion.e2e-spec.ts`, `test/order-list-my-orders.e2e-spec.ts` green.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots clean; all six tables (`cart`, `cart_line`, `order`, `order_line`, `address`, `payment`) present; legacy 5 tables gone.
- [ ] Every request in `http/cart.http` and `http/order.http` executes end-to-end against the seeded customer + seeded variants.
- [ ] After Place Order, RabbitMQ shows `retail.order.placed` and `retail.payment.authorized` published; the notification microservice logs an order-placed line (proves the consumer re-pointing worked).
- [ ] After Capture Payment, `retail.payment.captured` is published; Payment row in `captured` status; Order's `paymentStatus = captured`.
- [ ] `OrderLine.sku`, `OrderLine.nameSnapshot`, `OrderLine.unitPriceMinor` are populated and match the catalog state at place-time.
- [ ] Per-task docs present under `docs/implementation/epic-05-cart-order-payment-walking-skeleton/`.
- [ ] `README.md` System diagram + API sections rewritten; `CLAUDE.md` retail section rewritten.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
