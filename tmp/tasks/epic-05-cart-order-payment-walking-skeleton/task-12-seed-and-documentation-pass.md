---
epic: epic-05
task_number: 12
title: Seed + documentation pass — README, CLAUDE.md, arch-lint, test seed, e2e
depends_on: [01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11]
doc_deliverable: closing appends to docs/implementation/epic-05-cart-order-payment-walking-skeleton/01-retail-rebuild-and-old-tables-dropped.md + 02-cart-aggregate-and-q1-q3-decisions.md + 03-order-three-status-and-q4-decision.md + 06-address-polymorphic-snapshot.md + 08-idempotency-key-header-q10.md + 10-cart-and-order-http-files.md
---

# Task 12 — Seed + documentation pass

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** [ADR-017](../../docs/adr/017-architecture-lint-via-eslint-boundaries.md) (the architecture-lint fixture extension), [ADR-010](../../docs/adr/010-jwt-rbac-at-the-gateway.md) (the permission codes being seeded), [ADR-018](../../docs/adr/018-nestjs-monorepo-apps-and-libs.md) (the README structure for the monorepo).

## Goal

Close out epic-05. Extend the test seed so the seeded customer has one example cart with one line (the e2e test creates its own cart in step 1 of the test flow; the seeded cart exists only to prove the table structure works through the seeding layer). Seed the two new permission codes (`customer:own-orders:read`, `order:capture`). Ship the three e2e specs the epic requires (`cart-to-order-walking-skeleton`, `guest-cart-promotion`, `order-list-my-orders`). Rewrite the affected `README.md` and `CLAUDE.md` sections. Extend `spec/architecture-lint.spec.ts` for the new `cart/` and `payment-gateway/` element types. Final-pass the six docs that received partial writes from earlier tasks.

## Entry state assumed

Tasks 01–11 complete:

- All endpoints work end-to-end (verified manually via the `.http` files).
- The notification consumer is re-pointed to `retail.order.placed`; the cluster chain is intact.
- All wire DTOs + domain models + use cases + controllers on disk.
- Three docs (01, 02, 03) are partial — task-12 final-passes them.
- Doc 09 is complete (task-11 closed it).
- Docs 04, 05, 06, 07, 10 are complete from their owning tasks.

## Scope

**In:**

- **Extend `scripts/test-db-seed.ts`:**
  - After the existing customer + variant + warehouse seeds, run a new `seedCartExample` step that inserts one cart for the seeded customer:
    - `INSERT INTO cart (id, customer_id, currency, status, version) VALUES (<uuid>, '<seeded-customer-id>', 'USD', 'active', 0) ON DUPLICATE KEY UPDATE customer_id = VALUES(customer_id);`
    - One line: `INSERT INTO cart_line (cart_id, variant_id, quantity, unit_price_snapshot_minor, currency_snapshot) VALUES (<cart_uuid>, 1, 1, 1999, 'USD') ON DUPLICATE KEY UPDATE quantity = VALUES(quantity);`
    - The seed-cart id is a deterministic UUID derived from `(customer_id, 'seed-cart-v1')` so subsequent test runs don't accumulate carts.
  - Run a new `seedRetailPermissions` step that inserts the two new permission codes (`customer:own-orders:read`, `order:capture`) into the `permission` table (the table from epic-01 — verify the schema by re-reading `scripts/seeds/permissions.sql` from the existing seed file list) and binds them to the appropriate roles:
    - `customer:own-orders:read` → bound to the `customer` role (with the existing `customer:*` pattern from epic-01).
    - `order:capture` → bound to `admin` and `order-support` roles.
    - `order:read` — verify exists; if not, add and bind to `admin`, `order-support`.
- **New seed SQL file `scripts/seeds/retail-permissions.sql`:**
  ```sql
  -- Permission codes added by epic-05.
  INSERT INTO permission (code, description) VALUES
    ('customer:own-orders:read', 'Customer may read their own orders and carts'),
    ('order:capture', 'May capture authorized payments on any order'),
    ('order:read', 'May read any order (admin browse)')
  ON DUPLICATE KEY UPDATE description = VALUES(description);

  -- Role bindings.
  INSERT INTO role_permission (role_code, permission_code) VALUES
    ('customer', 'customer:own-orders:read'),
    ('admin', 'order:capture'),
    ('admin', 'order:read'),
    ('order-support', 'order:capture'),
    ('order-support', 'order:read')
  ON DUPLICATE KEY UPDATE role_code = VALUES(role_code);
  ```
  Adjust column names and tables to match epic-01's actual permission/role schema — verify before writing.
- **New seed SQL file `scripts/seeds/cart-example.sql`:**
  ```sql
  INSERT INTO cart (id, customer_id, currency, status, version)
  VALUES (UUID_TO_BIN('00000000-0000-4000-8000-000000000001'), '<seeded-customer-id>', 'USD', 'active', 0)
  ON DUPLICATE KEY UPDATE customer_id = VALUES(customer_id);
  -- ...similar for cart_line.
  ```
  (UUID literal shown is illustrative; the implementer picks the deterministic UUID generator.)
- Wire both SQL files into `scripts/utils/test-db-seed.util.ts`'s `seedFiles` array.
- **Three new e2e specs:**
  - `test/cart-to-order-walking-skeleton.e2e-spec.ts` — the canonical golden-path:
    1. Bootstrap (api-gateway + retail microservice + notification microservice + MySQL + RabbitMQ + Redis — same scaffolding the existing e2e tests use; verify against `test/` for the project's pattern).
    2. Customer logs in (epic-01's customer-side login).
    3. Customer creates Cart → expect 201 + cart id captured.
    4. Customer adds two CartLines (variantId=1 and variantId=2) → expect 200 + two lines.
    5. Customer places the Order with shipping + billing Addresses; `Idempotency-Key` header.
    6. Assert response: `orderNumber` non-empty, `status='pending'`, `paymentStatus='authorized'`, `fulfillmentStatus='unfulfilled'`.
    7. Customer fetches the Order; assert snapshot fields populated: `lines[0].sku` non-empty, `lines[0].nameSnapshot` non-empty, `lines[0].unitPriceMinor > 0`.
    8. Customer captures the Payment → expect 200 + `paymentStatus='captured'`.
    9. Repeat the place call with the same `Idempotency-Key` → assert a NEW `orderId` distinct from step 5's. Cite `epic-12` for the future dedupe behavior.
    10. (Optional) Verify the notification microservice's log output mentions the order placement — this requires the test harness to expose stdout reading, which may not be feasible; if not, skip this assertion with a comment.
  - `test/guest-cart-promotion.e2e-spec.ts` — the Q1 guest path:
    1. Anonymous client posts `POST /api/cart` → expect 201, a cart with `customerId=null`.
    2. Anonymous client adds a CartLine → expect 200.
    3. The anonymous client registers (epic-01's customer registration endpoint — verify it's exposed; if not, log in with a pre-seeded `guest` user; the doc explains the path).
    4. The now-authenticated client posts to `POST /api/cart/:id/lines` with the same cart id (bearer token now set) → expect 200 + the cart's `customerId` is now the registered user's id.
    5. The cart resolves under the new customer's `GET /api/cart/:id` call.
  - `test/order-list-my-orders.e2e-spec.ts` — the pagination + ownership scoping:
    1. Customer A places 3 orders (loop over Place Order 3 times with distinct carts).
    2. Customer B places 1 order.
    3. Customer A's `GET /api/orders` returns 3 orders, sorted by `placedAt DESC`.
    4. Customer B's `GET /api/orders` returns 1 order — none of A's.
    5. Customer A's `GET /api/orders?pageSize=1&pageNumber=2` returns the middle order.
- **Extend `spec/architecture-lint.spec.ts`:**
  - Add an `element-type` fixture for `payment-gateway` under `apps/retail-microservice/src/modules/orders/infrastructure/payment-gateway/`. Rules: the adapter can import from `application/ports/` (for the port interface), but NOT from `application/use-cases/` (no inverted dependency) and NOT from `domain/` (the gateway is below the domain in the dependency chain).
  - Add an `element-type` fixture for the gateway-side and retail-side `cart` module. Rules: cart-side imports — `domain/` allows only `libs/{ddd,common,contracts}` (the standard); `application/` allows `domain/` + ports + `libs/contracts`; `infrastructure/messaging/` allows `@nestjs/microservices` + the ports; `presentation/` allows controller decorators + the use cases.
  - Add a cross-module rule: `apps/retail-microservice/src/modules/cart/domain/**` cannot import from `apps/retail-microservice/src/modules/orders/**` and vice-versa (the two modules are independent — they share a service but not internals; the `PlaceOrderUseCase` imports the `CART_REPOSITORY` from cart's application/ports, which is the only legal cross-module bridge).
  - Add a fixture asserting `apps/notification-microservice/src/modules/notifications/infrastructure/consumers/order-events.consumer.ts` does NOT contain the literal `'retail.order.created'` (post-task-11; defensive — the lint fires if a future change re-introduces the literal).
  - Add a fixture asserting `apps/api-gateway/src/modules/retail/` does NOT exist (defensive — the lint fires if the deleted module is re-added).
- **Rewrite `README.md`** — affected sections:
  - **System diagram:** add `cart` + `order` + `payment` boxes inside the retail microservice; payment-gateway-port called out with the fake adapter as default; the retired legacy routing keys (`retail.order.create/confirm/get/created/confirmed/cancelled`) removed; the new keys (5 cart + 4 order/payment) shown.
  - **API → Orders** section: rewrite to cover the new endpoint set (place, get, list, capture).
  - **API → Cart** section: NEW.
  - **API → Payment gateway** subsection (under API): new — note the port-and-adapter, the fake default, the forward link to the real-gateway sketch.
  - **Authentication → Roles** section: update the role-permission table to include `customer:own-orders:read` and `order:capture`; cross-link epic-01's permission section.
  - **Database** section: brief paragraph on the six new tables (`cart`, `cart_line`, `order`, `order_line`, `address`, `payment`); cross-link doc 01 for the schema diff.
- **Rewrite `CLAUDE.md`** — affected sections:
  - **Retail microservice** section: rewrite to reflect the new shape — two sibling modules (`cart/` and `orders/`) plus the infrastructure-side `payment-gateway/` adapter folder. Provide a new file-listing snippet matching the project's existing format.
  - **Message patterns** list: remove the four legacy `retail.order.*` keys; add the seven new ones (`retail.cart.create/get/line.{append,quantity-set,remove}` + `retail.order.place/get/capture/list-mine`); add the 6 new event keys (`retail.cart.created/line-added/line-removed/line-quantity-changed` + `retail.order.placed` + `retail.payment.authorized/captured`); note the notification consumer re-pointing.
  - **Forbidden imports / boundaries** section: confirm `ClientProxy` and `PAYMENT_GATEWAY` adapter remain confined to `infrastructure/`. Add a sentence on the new `payment-gateway/` element type.
  - **Operational notes**: add a bullet on `Idempotency-Key` headers being accepted-not-enforced today, with the forward link to `epic-12`.
- **Final-pass appends to the partial docs:**
  - `01-retail-rebuild-and-old-tables-dropped.md` — write the "Cumulative after-snapshot" section (mermaid or ASCII diagram showing the six new tables, the FK arrows, the polymorphic Address composite index; a bullet list of the variantId/customerId/orderNumber-keyed surfaces).
  - `02-cart-aggregate-and-q1-q3-decisions.md` — small final-pass pass; ensure cross-links to docs 04, 05, 07, 10 are present.
  - `03-order-three-status-and-q4-decision.md` — small final-pass pass; ensure cross-links to docs 04, 05, 06, 07, 08 are present.
  - `06-address-polymorphic-snapshot.md` — small final-pass pass; verify the address-DTO shape in `libs/contracts/retail/orders/dto/address.dto.ts` matches doc text.
  - `08-idempotency-key-header-q10.md` — final-pass; add section 4 "Marker-case behavior change in `epic-12`" summarizing what changes when the dedupe lands (today the second call with same key returns 201/200; tomorrow it returns 200 with the cached body of the first response).
  - `10-cart-and-order-http-files.md` — verify against the actual shipped `.http` files for any drift between this task and task-10.

**Out:**

- New code in `apps/` / `libs/` beyond the seed extension, e2e tests, and arch-lint fixtures — none.
- New routing keys, new events, new use cases — none.
- The audit-log consumer — `epic-11`.

## Files to add

- `scripts/seeds/retail-permissions.sql`
- `scripts/seeds/cart-example.sql`
- `test/cart-to-order-walking-skeleton.e2e-spec.ts`
- `test/guest-cart-promotion.e2e-spec.ts`
- `test/order-list-my-orders.e2e-spec.ts`

## Files to modify

- `scripts/test-db-seed.ts` — extend with the two new seed steps.
- `scripts/utils/test-db-seed.util.ts` — add the two new seed files to the `seedFiles` array.
- `spec/architecture-lint.spec.ts` — extend with the new fixtures.
- `README.md` — System diagram + API → Orders + API → Cart + API → Payment gateway + Authentication → Roles + Database sections.
- `CLAUDE.md` — Retail microservice + Message patterns + Forbidden imports + Operational notes sections.
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/01-retail-rebuild-and-old-tables-dropped.md` — append the after-snapshot section.
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md` — final-pass.
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/03-order-three-status-and-q4-decision.md` — final-pass.
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/06-address-polymorphic-snapshot.md` — final-pass.
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/08-idempotency-key-header-q10.md` — final-pass + section 4.
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/10-cart-and-order-http-files.md` — final-pass.

## Tests

- The three new e2e specs (see above) are the primary deliverable for this task's test surface.
- `yarn test:unit` continues to pass (no new unit tests; existing ones unchanged).
- `yarn test:e2e` passes (with the new specs green).
- `yarn lint` passes; the new arch-lint fixtures fire correctly for invalid imports (verify by introducing a deliberate violation in a scratch file, watching the lint fail, then removing the scratch file).

## Doc deliverables

### Append "Cumulative after-snapshot" to `01-retail-rebuild-and-old-tables-dropped.md` (target +40 lines)

Sections (task-01 wrote 1–7; this task adds 8):

8. **Cumulative after-snapshot.**
   - **Before vs after** in tabular form: list the 5 old tables + their column counts, then the 6 new tables + their column counts.
   - **Mermaid (or ASCII) diagram** of the new schema: six boxes (`cart`, `cart_line`, `order`, `order_line`, `address`, `payment`), FK arrows. The cross-service `variant_id` arrow points off-diagram with a `(see epic-02)` label. The cross-gateway `customer_id` arrow points off-diagram with a `(see epic-01)` label.
   - **Identifier-keyed surfaces.** A single bullet list naming what surface uses what id: `cart.id` is UUID; `order.id` is BIGINT; `order.order_number` is the human-facing immutable string; `address.id` is UUID; `payment.id` is BIGINT; `payment.gateway_reference` is the unique deterministic UUID from the fake gateway.
   - **The four extension points.** A short list: real payment gateway (`epic-15`), Idempotency-Key dedupe (`epic-12`), OCC enforcement (`epic-12`), guest customer auto-creation (epic-01 follow-up). Each is named so a future contributor knows where to look.

### Section 4 of `08-idempotency-key-header-q10.md`

4. **Marker-case behavior change in `epic-12`.** Today the second Place Order call with the same `Idempotency-Key` produces a new `orderId` (201 with a different body). Tomorrow `epic-12` adds the `idempotency_key` table; the second call returns 200 with the body of the first response. The e2e test in this task includes the marker case (step 9 in `cart-to-order-walking-skeleton.e2e-spec.ts`) and asserts the "new id" behavior — when `epic-12` lands, that assertion flips. Naming the marker test makes the `epic-12` update mechanical.

### Final-pass appends to 02, 03, 06, 10

Light-touch: verify cross-links, ensure no broken references, ensure the doc text matches the final shipped code shape. No new sections required; this is editorial alignment.

## Carryover produced (closes the epic)

- All ten topic-numbered docs under `docs/implementation/epic-05-cart-order-payment-walking-skeleton/` exist + complete.
- `README.md` and `CLAUDE.md` reflect the new shape.
- `spec/architecture-lint.spec.ts` covers the new element types + the defensive negative fixtures.
- Three e2e specs green.
- The seed extension produces the example cart + the new permission codes; subsequent test runs are deterministic.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes (all prior + no new unit specs added here).
- [ ] `yarn test:e2e` passes; the three new specs (`cart-to-order-walking-skeleton`, `guest-cart-promotion`, `order-list-my-orders`) green.
- [ ] `docker compose up -d && yarn migration:run && yarn test:seed` runs clean; the example cart + permission codes are present.
- [ ] `docker compose up -d && yarn start:dev` boots the full stack; all six new tables present; legacy 5 tables gone; RabbitMQ shows the new routing keys; the notification microservice logs an order-placed line when an order is placed.
- [ ] Every request in `http/cart.http` and `http/order.http` executes end-to-end against the seeded customer + seeded variants.
- [ ] The ten topic-numbered docs (01 through 10) exist under `docs/implementation/epic-05-cart-order-payment-walking-skeleton/`.
- [ ] `README.md` System diagram + API → Cart + API → Orders + API → Payment gateway + Authentication → Roles sections rewritten.
- [ ] `CLAUDE.md` Retail microservice + Message patterns + Forbidden imports + Operational notes sections rewritten.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.
