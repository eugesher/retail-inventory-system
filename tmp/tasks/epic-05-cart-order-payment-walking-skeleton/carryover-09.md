# Carryover 09 — Final: seed + docs + README/CLAUDE + lint fixtures (capability complete)

This is the **final** carryover for the cart / order / payment walking skeleton.
The capability is whole; nothing in this epic remains for a later task.

## What is complete (the whole capability)

- **Six tables** live in the one shared MySQL DB: `cart`, `cart_line`, `order`,
  `order_line`, `address`, `payment` (verified present after a fresh
  `down -v → migrate`). The four legacy order tables were dropped in task-01.
- **The operations run end to end:**
  - Cart (mutable, `modules/cart/`): Create / Get / Add-line / Change-line-qty /
    Remove-line / Claim — six `@MessagePattern`s on `retail_queue`, fronted at
    `/api/cart`. Add-to-Cart snapshots the applicable price; unpriced variant → 409.
  - Place Order (`retail.cart.place`, served by the orders controller): converts an
    `active` cart → immutable `Order`, snapshots lines + addresses, authorizes
    payment inline via `PAYMENT_GATEWAY` (`FakePaymentGatewayAdapter`, always
    approves), emits `retail.order.placed` + `retail.payment.authorized`.
  - Capture (`retail.payment.capture`), Get Order (`retail.order.get`), List My
    Orders (`retail.order.list`) — fronted at `/api/orders` (owner-or-staff).
- **Notification re-point** (task-08): `retail.order.placed` →
  `OrderEventsConsumer` → `SendOrderNotificationUseCase` on `notification_events`.
- **Example cart seed** (this task): `scripts/seeds/cart.sql` — one `active` cart
  (`00000000-0000-4000-d000-000000000001`) for the seeded customer with one line
  (variant 1 ×2 @ 4999 USD). Idempotent; verified to re-seed twice + apply on a
  fresh reload.
- **Docs `01`–`10`** all present under
  `docs/implementation/05-cart-order-payment-walking-skeleton/`. ADR-028 recorded
  (Accepted, supersedes ADR-013); ADR-013 status flipped to Superseded.
- **README + CLAUDE** reflect the final surface (see below).
- **`spec/architecture-lint.spec.ts`** has retail `cart` + `orders` bumpers, the
  `payment-gateway` infrastructure-classification fixture, and the cart↔orders
  cross-module bumper. No `eslint.config.mjs` change was needed.

## Files added / modified (this task)

**Added**
- `scripts/seeds/cart.sql` — the example cart + line (idempotent).
- `docs/implementation/05-cart-order-payment-walking-skeleton/10-cart-and-order-http-files.md`.
- `tmp/tasks/.../carryover-09.md` (this file).

**Modified**
- `scripts/utils/test-db-seed.util.ts` — `'cart.sql'` appended to `seedFiles`
  (after `stock-level.sql`; it depends on the customer + variant + price seeds).
- `scripts/test-db-seed.ts` — **re-ordered** so the JS identity pass (permissions /
  roles / staff / **customers**) runs **before** the SQL fixtures, so the cart's
  `customer_id` FK is satisfied when `cart.sql` runs. (No catalog/pricing/stock
  SQL depends on identity, so the re-order is safe.)
- `README.md` — system-diagram retail box rewritten (cart + orders modules,
  `PAYMENT_GATEWAY → FakePaymentGatewayAdapter`, `Emits retail.order.placed ->
  notification`); notification box now lists `retail.order.placed`; new
  **`### Payment gateway`** subsection under `## API` (port/adapter split, fake
  default, real-gateway swap); example-cart + `order:capture` seed rows documented.
- `spec/architecture-lint.spec.ts` — two new describe blocks (retail `cart`,
  retail `orders`); the inventory "use case may not reach another app" fixture
  **repointed** from the catalog `product.model` back to the retail
  `orders/domain/order.model` (it exists again after the rebuild — the task's
  stated expectation; same 6-level depth, resolves green).

**Not modified**
- **`CLAUDE.md` needed no edit** — tasks 02–08 each updated it incrementally, so it
  already describes the final cart/orders/Payment/PAYMENT_GATEWAY surface, the full
  message-pattern list (legacy `retail.order.*` retired; the new cart/order/payment
  keys added; the notification re-point + reserved-vs-active split), the boundary
  rule (`ClientProxy` confined to `infrastructure/messaging/`; the payment-gateway
  adapter sits under `infrastructure/payment-gateway/`), and the gateway
  `modules/cart/` + `modules/orders/` + the auth guest-session endpoint. Verified by
  grep; no stale "foundation only" text remains.
- **No new migration** (no schema change — all six tables exist from tasks 01–04).

## Key decisions & deviations

- **Identity-before-SQL seed order** (not in the task's file list as a behavior
  change, but required): `cart.sql` FKs `customer(id)`, and `ON DELETE SET NULL`
  does not relax the INSERT FK check, so the customer must exist first. Cleanest
  fix was to run the JS identity seeds ahead of the SQL fixtures.
- **The cart_line seed is a `WHERE NOT EXISTS` guarded insert keyed on
  `(cart_id, variant_id)`, NOT a hardcoded-id `INSERT IGNORE`.** `cart_line.id` is
  `AUTO_INCREMENT` and e2e-built carts draw from the same sequence, so a fixed seed
  id (`id=1`) collides with a real line's id on a non-fresh DB (observed: the line
  was silently skipped). The guarded insert is idempotent on the business pair and
  never collides. The cart **row** stays `INSERT IGNORE` (its UUID PK is unique to
  the seed). This is the one notable deviation from the task's "INSERT IGNORE or
  INSERT IGNORE" suggestion.
- **`order:capture`** is confirmed seeded (id `…-b000-00000000000e`) and bound to
  `order-support` + `admin` (task-07); README documents it as the staff override.
- **The architecture-lint fixtures point at real retail files** so the boundaries
  resolver types the targets: `cart/domain/cart.model`, `orders/domain/order.model`,
  `orders/infrastructure/payment-gateway/fake-payment-gateway.adapter`. The
  payment-gateway fixture (presentation → that adapter) firing proves
  `infrastructure/payment-gateway/` is classified `infrastructure` by the generic
  `apps/*/src/modules/*/infrastructure/**` pattern (no config change).

## Verify matrix (all green as of this task)

- `yarn lint` — clean (`--max-warnings 0`).
- `yarn test:unit` — **667 pass / 89 suites** (was 653; +14 from the new retail
  `cart`/`orders` architecture-lint fixtures).
- `yarn test:e2e` — full reload (`down -v` → up → `migration:run` → `test:seed`) +
  **114 pass / 15 suites** (cart-operations, guest-cart-promotion,
  cart-to-order-walking-skeleton, order-list-my-orders, notification, +
  catalog/inventory/pricing/auth/iam). The `cart.sql` seed applies cleanly on the
  fresh DB.
- **Seed idempotency** — `yarn test:seed` run twice in a row succeeds with no error
  and no duplicate (verified: exactly one line for the seeded cart after two runs).
- **Migrations** — `yarn migration:run` reports no pending (all applied); no new
  migration this task. Up/down round-trips for the six tables were verified in
  tasks 01–04.
- **Six tables present** after a fresh reload: `address`, `cart`, `cart_line`,
  `order`, `order_line`, `payment`.
- **`http/cart.http` + `http/order.http`** mirror the green e2e flows (login →
  cart build → place → get → list → capture → repeat; guest-session → claim). Both
  files are documented in doc `10`; the endpoints they hit are all exercised by the
  passing e2e suites.
- **Self-containment grep** clean (exit 1, no matches):
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.

## Deferred follow-on capabilities (explicitly out of this epic)

Each is a named future capability, not a gap in this one:

- **Inventory reservation / allocation** at add-to-cart or place time (and the
  removal of the `inventory.order.confirm` deprecation stub) — owned by the
  inventory-reservation capability (ADR-027).
- **Fulfillment**: ship / deliver transitions on the order `fulfillmentStatus`
  axis (the axis exists; no mutators yet).
- **Order cancel** (`Order` has no cancel mutator; the old `RETAIL_ORDER_CANCELLED`
  key was retired).
- **Returns / refunds / void / partial capture** on `Payment` (only
  `authorized → captured` exists).
- **A real payment gateway** (Stripe/Adyen) — a single `PAYMENT_GATEWAY` rebind +
  an HTTP-doing sibling adapter; the fake is the default today.
- **`Idempotency-Key` persistence + dedupe** — the header is accepted + logged but
  not deduped; repeat-place/re-capture safety is state-driven today.
- **OCC enforcement** on `cart.version` / `order.version` (the columns + in-memory
  bumps ship now; no conflict guard reads them yet).
- **An admin all-orders listing** (List My Orders is own-only; staff `order:read`
  reaches a single order by id, not a cross-customer list).
- **Auto-promotion of a guest cart on login** (implicit merge) — claim is explicit
  today via `fromCustomerId`.
- The reserved retail events (`retail.cart.*`, `retail.payment.authorized`,
  `retail.payment.captured`) stay on `retail_queue` with no consumer — a later
  audit / fulfillment capability.
