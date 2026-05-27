---
epic: epic-05
task_number: 10
title: Author `http/cart.http`; rewrite `http/order.http`
depends_on: [09]
doc_deliverable: docs/implementation/epic-05-cart-order-payment-walking-skeleton/10-cart-and-order-http-files.md
---

# Task 10 — Author `http/cart.http`; rewrite `http/order.http`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** [ADR-010](../../docs/adr/010-jwt-rbac-at-the-gateway.md) (the access-token / refresh-token shape used in the file headers).

## Goal

Ship the two Kulala HTTP files that exercise the new cart + order endpoints end-to-end:

- **`http/cart.http`** — NEW. Covers: `POST /api/cart`, `GET /api/cart/:cartId`, `POST /api/cart/:cartId/lines`, `PATCH /api/cart/:cartId/lines/:lineId`, `DELETE /api/cart/:cartId/lines/:lineId`. Header captures the seeded customer's login + the access token + the cart id.
- **`http/order.http`** — REWRITTEN. Covers: `POST /api/cart/:cartId/place`, `GET /api/orders/:orderId`, `GET /api/orders` (the list), `POST /api/orders/:orderId/payments/capture`. The place + capture requests include an `Idempotency-Key: {{$uuid}}` header with a Kulala-generated UUID.

Kulala is the project's HTTP-file runner (a VS Code extension); the project's convention is one `.http` file per HTTP concern, with the file's first request being a login that captures `access_token`, `refresh_token`, and any IDs subsequent requests need.

## Entry state assumed

Task-09 carryover present:

- All HTTP endpoints work; the seeded customer (`customer@retail.local` per epic-01) can hit them.
- The two seeded variants from epic-02 exist (`variantId=1`, `variantId=2`).
- The seeded `default-warehouse` from epic-04 task-02 exists.
- `Idempotency-Key` headers are accepted (forwarded, not enforced).

## Scope

**In:**

- **New `http/cart.http`** with this structure:
  1. Variables block at the top: `@hostname = http://localhost:3000` (verify; the project may use a different port — check `apps/api-gateway/src/main.ts`).
  2. Login request (the seeded customer per epic-01): `POST {{hostname}}/auth/login` with `{ "email": "customer@retail.local", "password": "<seeded-password>" }`. Captures `accessToken`, `refreshToken`, `customerId` (from the response).
  3. Create cart: `POST {{hostname}}/api/cart` with `Authorization: Bearer {{accessToken}}` + optional `{ "currency": "USD" }`. Captures `cartId`.
  4. Get cart: `GET {{hostname}}/api/cart/{{cartId}}`.
  5. Add line 1: `POST {{hostname}}/api/cart/{{cartId}}/lines` with `{ "variantId": 1, "quantity": 2 }`.
  6. Add line 2: `POST {{hostname}}/api/cart/{{cartId}}/lines` with `{ "variantId": 2, "quantity": 1 }`. Captures `lineId` (the id of one of the lines, for the subsequent PATCH/DELETE).
  7. Change quantity: `PATCH {{hostname}}/api/cart/{{cartId}}/lines/{{lineId}}` with `{ "quantity": 3 }`.
  8. Remove line: `DELETE {{hostname}}/api/cart/{{cartId}}/lines/{{lineId}}`.
  9. Get cart (final state): `GET {{hostname}}/api/cart/{{cartId}}` — used to confirm the lines reflect all mutations.
  10. (Anonymous variant) `POST {{hostname}}/api/cart` with no `Authorization` — captures a separate `guestCartId`. This exists to exercise the Q1 guest path. Subsequent guest mutations are not chained — the e2e test (task-12) covers the full guest-promotion flow.
- **Rewritten `http/order.http`** with this structure:
  1. Variables block: `@hostname = http://localhost:3000`.
  2. Login — same as cart.http; captures `accessToken`, `refreshToken`, `customerId`.
  3. Create cart + add two lines (compressed — one request per line; or reference the `cart.http` flow as a prerequisite via a comment). Captures `cartId`.
  4. **Place order** — `POST {{hostname}}/api/cart/{{cartId}}/place` with `Authorization: Bearer {{accessToken}}`, `Idempotency-Key: {{$uuid}}` (Kulala-generated per-call UUID), and body `{ "currency": "USD", "shippingAddress": { ... full address shape ... }, "billingAddress": { ... }, "paymentMethod": { "token": "fake-card-token" } }`. Captures `orderId` (`{{response.body.id}}`) and `orderNumber` and `paymentId`.
  5. **Get order** — `GET {{hostname}}/api/orders/{{orderId}}`. The response is asserted to have `paymentStatus: "authorized"` and two OrderLines with `sku` + `nameSnapshot` + `unitPriceMinor` populated.
  6. **List my orders** — `GET {{hostname}}/api/orders?pageNumber=1&pageSize=20`. The response is asserted to include the just-placed order.
  7. **Capture payment** — `POST {{hostname}}/api/orders/{{orderId}}/payments/capture` with `Authorization: Bearer {{accessToken}}`, `Idempotency-Key: {{$uuid}}`. The response is asserted to have `paymentStatus: "captured"`.
  8. **Get order (again)** — `GET {{hostname}}/api/orders/{{orderId}}` to verify the new `paymentStatus`.
  9. (Marker case) **Place order again with the same Idempotency-Key** — the request body and the `Idempotency-Key` header are copied verbatim from step 4. The response carries a NEW `orderId` distinct from step 4's (the dedupe is not enforced — `epic-12`). A comment cites `epic-12` for the future behavior change.
- **Delete the legacy `http/product.http`** if it exists (verify — epic-04 task-09 may have already deleted it; if absent, no-op).
- **Doc deliverable** `10-cart-and-order-http-files.md`.

**Out:**

- Test seeds — task-12.
- E2E test files — task-12.

## Kulala syntax notes

- `{{variableName}}` resolves at request time.
- `# @name <name>` before a request lets a later request reference `{{<name>.response.body.<path>}}` (Kulala's request-chaining syntax — verify against existing project files like `http/auth.http` if present).
- `{{$uuid}}` generates a fresh UUID per request — used here for `Idempotency-Key`.
- File-level variables (`@hostname = ...`) at the top, request-level variables inside the request block.

The implementer should verify Kulala's exact syntax against the project's existing `.http` files (e.g. `http/auth.http`, `http/inventory.http` if shipped by epic-04 task-09). If the project's Kulala version differs from the assumed syntax, adapt — the structure above is the intent; the literal syntax is what Kulala expects.

## Files to add

- `http/cart.http`
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/10-cart-and-order-http-files.md`

## Files to modify

- `http/order.http` — rewritten end-to-end.

## Files to delete

- `http/product.http` (if it exists — verify before deleting).

## Tests

- This task has no unit tests. The e2e tests in task-12 (`cart-to-order-walking-skeleton.e2e-spec.ts`) cover the flow programmatically.
- Manual verification: open each `.http` file in VS Code with the Kulala extension, run each request top-to-bottom in order, observe 2xx responses and the asserted body shape.

## Doc deliverable

Write `docs/implementation/epic-05-cart-order-payment-walking-skeleton/10-cart-and-order-http-files.md` (target ~80 lines). Sections:

1. **Why two files.** Cart and Order are separate Kulala flows because (a) the cart flow exercises mutations only inside the retail-microservice (no payment gateway, no order rows); (b) the order flow assumes a cart already exists and exercises the full chain through to capture. Splitting them lets a contributor exercise one without the other.
2. **The seeded customer's credentials.** Cite the seed file location (`scripts/test-db-seed.ts` plus the SQL seeds under `scripts/seeds/`); the email + password are documented in `epic-01`'s doc folder. Both `.http` files use the same login.
3. **The seeded variants.** Cite `epic-02`'s seed; the two variant IDs (1 and 2) and their SKUs.
4. **The `Idempotency-Key` header.** What's required, what's not. Today the value is generated per-request via `{{$uuid}}`; the marker case (step 9 in `order.http`) reuses the value from step 4 to prove the dedupe is not enforced. Forward link to `epic-12`.
5. **The address body shape.** Cite the wire DTO at `libs/contracts/retail/orders/dto/address.dto.ts`. The example body uses a US address with ZIP code; the country code is `"US"`. The 2-char ISO check at the domain layer rejects other shapes.
6. **The cart-place URL space.** Cite the ADR-009 decision discussed in task-09's notes: `POST /api/cart/:cartId/place` is on the cart URL space but lives in the orders module; this is intentional and documented here for someone reading the `.http` file out of context.
7. **The list-orders pagination shape.** `pageNumber` is 1-based, `pageSize` defaults to 20, clamped at 100.
8. **Manual verification flow.** A short paragraph: open in VS Code, ensure docker-compose + the dev stack is up, run requests top-to-bottom. Cite the `Idempotency-Key` marker case (step 9) and what to look for in the response (a new orderId).

## Carryover produced (consumed by task-11 onward)

- `http/cart.http` and `http/order.http` ship.
- `http/product.http` deleted if it existed.
- Doc 10 written.

## Exit criteria

- [ ] `http/cart.http` and `http/order.http` exist on disk.
- [ ] Every request in `http/cart.http` (≥10 requests) executes end-to-end against the dev stack with a 2xx response (manual verification).
- [ ] Every request in `http/order.http` (≥9 requests) executes; the Idempotency-Key marker case (step 9) returns a new `orderId` distinct from step 4.
- [ ] `http/product.http` does NOT exist (or was already absent).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc 10 exists with the eight sections above.
