---
epic: epic-05
task_number: 9
title: Seed + docs + README/CLAUDE + lint-fixtures finalization
depends_on: [1, 2, 3, 4, 5, 6, 7, 8]
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/10-cart-and-order-http-files.md
---

# Task 09 — Seed + docs + README/CLAUDE + lint-fixtures finalization

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-017** (the `eslint-plugin-boundaries` rules + the
`spec/architecture-lint.spec.ts` fixture suite; the generic
`apps/*/src/modules/*/...` element patterns classify the new retail modules — **no
`eslint.config.mjs` change is expected**, only new fixtures), **ADR-009/ADR-004**
(the per-module boundaries the new fixtures lock in), **ADR-019** (the test seed is
idempotent SQL + the `test-db-seed` orchestration), **ADR-028** (the chain whose
final docs + README/CLAUDE you write).

## Goal

Close the capability: extend the test seed with an example cart for the seeded
customer, write the final implementation doc (`10`), give `README.md` + `CLAUDE.md`
their full rewrite for the cart/order/payment surface, add `spec/architecture-lint.spec.ts`
bumpers for the new retail `cart/` + `orders/` modules (incl. the `payment-gateway`
infrastructure), and run the self-containment grep clean across the whole tree.

## Entry state assumed

- task-01–08 complete. The full cart→order→payment chain works end-to-end; the
  notification consumer is repointed; docs `01`–`09` exist; `http/cart.http` +
  `http/order.http` exist; the seed binds `order:capture`. The README/CLAUDE have
  only the minimal dropped-route edits from task-01 (the new surface is undocumented
  in them).
- `spec/architecture-lint.spec.ts` has describe blocks for inventory `stock`, gateway
  `auth`/`iam`, catalog `catalog`, and `pricing` — but **none** for the retail
  `cart`/`orders` modules.

## Seed (`scripts/test-db-seed.ts` + `scripts/seeds/`)

- Add an example **cart** for the seeded customer (`00000000-0000-4000-a000-000000000002`):
  one `active` cart (stable UUID, e.g. `00000000-0000-4000-d000-000000000001`),
  currency `USD`, with one `cart_line` for a seeded variant (id `1`) whose
  `unit_price_snapshot_minor` matches the seeded USD price from `price.sql`. Realize
  it as a `scripts/seeds/cart.sql` (idempotent — `INSERT … ON DUPLICATE KEY UPDATE`
  or `INSERT IGNORE`) added to `TestDbSeedUtil.seedFiles` **after**
  `catalog-product-variant.sql` + `price.sql` (the cart line FKs `product_variant`
  and snapshots the price). This sets up an e2e/`http/cart.http` prerequisite without
  seeding the actual e2e flow (the e2e specs build their own carts). Re-running
  `yarn test:seed` must not error or duplicate.
- Confirm `order:capture` is seeded (task-07) and bound to `order-support` + `admin`.

## Documentation — `10` + README + CLAUDE

### Implementation doc

`docs/implementation/05-cart-order-payment-walking-skeleton/10-cart-and-order-http-files.md`
— document the two Kulala files: `http/cart.http` (create cart, add/change/remove
line, get cart, guest-session, claim) and `http/order.http` (place, get, list,
capture, idempotent repeat); the seeded-customer login + token capture convention;
the `Idempotency-Key` header usage. Cross-link the sibling docs `01`–`09`.

### `README.md` (full pass)

- **System diagram** — rewrite the retail box to show `cart` + `orders` modules and
  the `PAYMENT_GATEWAY` port with its `FakePaymentGatewayAdapter` default; show
  `retail.order.placed → notification`; remove the retired `retail.order.*` legacy
  keys from the diagram.
- **API → Orders** — rewrite for the new endpoint set (`GET /api/orders/:id`,
  `GET /api/orders`, `POST /api/orders/:id/payments/capture`).
- **API → Cart** — new section (`POST /api/cart`, `GET /api/cart/:id`,
  `POST/PATCH/DELETE …/lines[/:lineId]`, `POST …/place`, `POST …/claim`, and the
  `POST /auth/customer/guest-session` bootstrap).
- **Payment gateway** — new subsection under API: the port-and-adapter split + the
  fake default + how a real gateway swaps in.
- **Authentication → Roles** — add `order:capture` (admin + order-support); note that
  customer self-service is owner-checked, not permission-gated (cross-link the
  baseline identity / RBAC section).
- Seed-data / env tables — add the example cart + `order:capture` rows where the
  README lists seeded fixtures.

### `CLAUDE.md` (full pass)

- **Retail microservice** section — rewrite: the service now hosts `cart/` and
  `orders/` modules (the latter also holding `Payment` + the `payment-gateway/`
  infrastructure adapter + the `PAYMENT_GATEWAY` port + `ITransactionPort`); the new
  file-listing snippet; the bearer + owner-check authorization note.
- **Message patterns** — remove the four legacy `retail.*` keys; add the new set
  (cart RPCs + events, `retail.cart.place`, `retail.order.{placed,get,list}`,
  `retail.payment.{capture,authorized,captured}`); note the notification consumer
  re-point and which events are reserved (no consumer) vs active.
- **Forbidden imports / boundaries** — confirm `ClientProxy` + the `PAYMENT_GATEWAY`
  adapter stay confined to `infrastructure/`; the cart/orders modules follow the
  per-module hexagonal shape.
- **API Gateway** — note the new `modules/cart/` + `modules/orders/` thin
  RPC-fronting modules and the auth `guest-session` endpoint.

## `spec/architecture-lint.spec.ts` fixtures

Add describe blocks for the retail `cart` and `orders` modules, mirroring the
catalog/pricing blocks (point each fixture at a real path so the boundaries resolver
types the target; the generic element patterns classify them — **no
`eslint.config.mjs` edit**):
- retail `cart` — domain may not import `@nestjs/common` / `typeorm`; application
  use-case may not import `typeorm` / `@nestjs/typeorm`; application port may not
  import `typeorm`; presentation may not import `@retail-inventory-system/database`.
- retail `orders` — the same per-layer bumpers, plus a fixture proving the
  `infrastructure/payment-gateway/` adapter is classified as `infrastructure` (e.g.
  presentation may not import the `orders/infrastructure/payment-gateway/...` adapter
  — a cross-element denial). Optionally a cross-module bumper proving `cart` domain
  may not import `orders` domain (the two modules are isolated).
- Verify the **pre-existing** fixture that imports
  `retail-microservice/src/modules/orders/domain/order.model` (in the inventory
  "use case may not reach another app" case) still resolves — `order.model.ts` exists
  again after the rebuild, so it should; if its relative depth changed, fix the path.

## Files to add

- `scripts/seeds/cart.sql`
- `docs/implementation/05-cart-order-payment-walking-skeleton/10-cart-and-order-http-files.md`

## Files to modify

- `scripts/utils/test-db-seed.util.ts` — add `'cart.sql'` to `seedFiles` (after
  `catalog-product-variant.sql` + `price.sql`).
- `scripts/test-db-seed.ts` — only if the example cart needs JS-side seeding rather
  than pure SQL (prefer the SQL file; keep idempotent).
- `README.md`, `CLAUDE.md` — the full passes above.
- `spec/architecture-lint.spec.ts` — the new retail `cart`/`orders` describe blocks.

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`): `spec/architecture-lint.spec.ts` stays green — the new
  retail fixtures report the expected `boundaries/dependencies` ruleId; the positive
  cases do not flag. No other unit changes.
- **E2E** (`yarn test:e2e`): the full suite (cart, guest, place, capture, list,
  notification, plus catalog/inventory/pricing/auth/iam) passes on a fresh
  `migration:run` + seed; the example cart seed applies idempotently.
- **Seed**: `yarn test:seed` run twice in a row succeeds without error or duplicate
  rows.
- **Self-containment gate** (the §6 grep) — run and investigate every hit:
  ```bash
  grep -rniE 'tmp/|\bepic\b|\btask\b' \
    docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
  ```
  Expect no orchestration references. Remove any pre-existing leak encountered.

## Doc deliverable

`10-cart-and-order-http-files.md` (above) + the README/CLAUDE passes. Describe
everything by capability — never by an epic/task number.

## Carryover to read

`carryover-01.md` … `carryover-08.md`.

## Carryover to produce

Write `carryover-09.md` — the **final** carryover. Capture: that the capability is
complete (all six tables, the seven operations, the notification re-point, the
example cart seed, docs `01`–`10`, README/CLAUDE rewritten, the architecture-lint
fixtures); the full verify matrix (lint, unit, e2e, migrate up/down, boot, the
`http/*.http` sequences, the self-containment grep); and a short list of explicitly
deferred follow-on capabilities surfaced by this work (reservation/allocation at
cart/place-time; fulfillment / ship / deliver; cancel; returns/refunds; a real
payment gateway; idempotency-key persistence + dedupe; OCC enforcement on
cart/order; an admin all-orders listing; auto-promotion-on-login for guest carts;
the inventory confirm-seam removal owned by the inventory-reservation capability).

## Exit criteria

- [ ] `scripts/seeds/cart.sql` seeds an example cart + line for the seeded customer;
      `yarn test:seed` is idempotent.
- [ ] `README.md` System diagram + API (Cart, Orders, Payment gateway, Roles)
      sections rewritten; `CLAUDE.md` retail section + message-pattern list +
      gateway notes rewritten.
- [ ] `spec/architecture-lint.spec.ts` has retail `cart`/`orders` bumpers (incl. the
      `payment-gateway` infrastructure) and is green; no `eslint.config.mjs` change
      was needed.
- [ ] All ten docs `01`–`10` are present under
      `docs/implementation/05-cart-order-payment-walking-skeleton/`; ADR-028 is
      recorded and ADR-013 is marked superseded.
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` passes;
      `yarn test:e2e` passes (cart-to-order, guest-cart-promotion,
      order-list-my-orders, notification, + the prior-domain specs).
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots clean; all
      six tables present; every `http/cart.http` + `http/order.http` request executes.
- [ ] The self-containment grep is clean across
      `docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- [ ] `carryover-09.md` is written.
