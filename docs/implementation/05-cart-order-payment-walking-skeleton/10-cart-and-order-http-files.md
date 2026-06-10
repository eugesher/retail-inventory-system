# 10 — The cart + order HTTP files and the token-capture convention

Every gateway endpoint in this capability is exercised by a Kulala-style `.http`
file under [`http/`](../../../http/), so the whole checkout flow can be run
request-by-request from an editor without a client app. The checkout surface is
split across two files that mirror the two gateway modules:

- [`http/cart.http`](../../../http/cart.http) — the mutable cart: create, read,
  add / change / remove a line, the guest-session bootstrap, and the claim
  (guest-cart promotion).
- [`http/order.http`](../../../http/order.http) — the immutable order: place
  (a cart action that produces an order), get, list, capture, and the
  idempotent repeat-place.

This document explains the shared conventions both files follow — the seeded
login + bearer-token capture, the `Idempotency-Key` header, and the run order —
so a reader can drive the flow end to end. The files themselves carry per-request
header comments citing the controller path and body shape; this page is the map.

## The shared prerequisite — boot, migrate, seed

Both files open with the same `# Prereqs:` block. The flow assumes a running
stack with the schema migrated and the deterministic fixtures loaded:

```bash
docker compose up -d
yarn migration:run
yarn test:seed
yarn start:dev
```

`yarn test:seed` loads the [seeded customer](../../../scripts/test-db-seed.ts)
(`customer@example.com` / `customer1234`) plus the catalog / pricing / stock
fixtures the requests reference (variant 1 priced `4999`, variant 3 priced
`19999`). It also loads an example cart (`scripts/seeds/cart.sql`) for the seeded
customer, so `GET /api/cart/:cartId` against the stable id
`00000000-0000-4000-d000-000000000001` returns a populated cart on a cold start
— though both files build their own carts as well, so they run straight through
without referencing the seeded one.

## The login + token-capture convention

All cart and order routes are bearer-protected (a registered **or** guest
customer token passes). Both files therefore make the **first request** a login
and capture the resulting access token into a file variable that every protected
request below substitutes into its `Authorization` header:

```http
# @name login
POST {{baseUrl}}/auth/customer/login
Content-Type: application/json

{ "email": "customer@example.com", "password": "customer1234" }

###
@accessToken = {{login.response.body.$.accessToken}}
```

`# @name login` names the request so its response is addressable; the
`@accessToken = {{login.response.body.$.accessToken}}` line pulls the token out
of the JSON body into a variable. Each subsequent request carries
`Authorization: Bearer {{accessToken}}`. The same pattern captures other
response fields the flow needs downstream — `@cartId` from `createCart`,
`@lineId` from the first `addLine`, `@orderId` from `placeOrder`, and (in the
guest flow) `@guestAccessToken` + `@guestCustomerId` from `guestSession`. Running
the file top to bottom keeps every variable populated.

This is the same authorization model the gateway enforces
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) /
[ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)): a customer
token carries **no permission claim**, so the cart and order routes are gated by
an **owner-check** (the route folds `@CurrentUser().id` into the command and the
retail use case enforces `cart.customerId === subject` /
`order.customerId === subject`), not a `@RequiresPermission` code. A staff
`order:read` / `order:capture` permission is an *override* layered on top — it
lets staff read or capture any order, never a gate on the owning customer.

### The guest bootstrap (`cart.http`)

`POST /api/auth/customer/guest-session` is the one `@Public()` exception in the
cart flow: it mints a real, logged-in-able `status='guest'` Customer (null
password) and returns a customer-tier token plus its `customerId`. The guest
builds a cart through the **same** bearer-protected routes with the guest token;
`claimCart` then promotes that cart to the registered customer, passing the guest
id as `fromCustomerId` — the ownership proof. See
[02 — Cart aggregate](02-cart-aggregate-and-q1-q3-decisions.md) for the
guest-promotion rationale (Q1 / Q7).

## The `Idempotency-Key` header

`placeOrder`, `placeOrderAgain`, and `capturePayment` each send an
`Idempotency-Key` header (`{{$guid}}` mints a fresh UUID per send):

```http
POST {{baseUrl}}/cart/{{cartId}}/place
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
```

The header is **accepted, forwarded to the retail service, and logged — but not
deduped**. It is in the files to document the contract a future
idempotency-persistence capability will honor, not to provide dedupe today. The
safety that *does* exist is **state-driven**, which is why `placeOrderAgain`
demonstrates it with a brand-new key:

- **Repeat place** is safe because a placed cart is `converted`; re-placing it
  returns the order it already converted into (resolved via `order.source_cart_id`),
  not a second order.
- **Re-capture** is safe because an already-`captured` payment returns its
  current state with no second gateway call.

See [08 — The `Idempotency-Key` header (Q10)](08-idempotency-key-header-q10.md)
for why state-driven idempotency was chosen over a persisted key store for the
walking skeleton.

## The cart flow (`http/cart.http`)

| Request | Method + path | Notes |
|---|---|---|
| `login` | `POST /api/auth/customer/login` | captures `@accessToken` |
| `createCart` | `POST /api/cart` | `{ currency? }`; captures `@cartId` |
| `getCart` | `GET /api/cart/:cartId` | owner-checked read |
| `addLine` | `POST /api/cart/:cartId/lines` | `{ variantId, quantity }`; price snapshotted retail-side; captures `@lineId` |
| `changeLineQuantity` | `PATCH /api/cart/:cartId/lines/:lineId` | `{ quantity }` (`0` rejected) |
| `removeLine` | `DELETE /api/cart/:cartId/lines/:lineId` | back to an empty cart |
| `guestSession` | `POST /api/auth/customer/guest-session` | `@Public()`; captures `@guestAccessToken` + `@guestCustomerId` |
| `guestCreateCart` | `POST /api/cart` | with the guest token; captures `@guestCartId` |
| `claimCart` | `POST /api/cart/:cartId/claim` | registered token + `{ fromCustomerId }` proof |

The price is **never sent** on `addLine` — it is snapshotted retail-side from
`catalog.price.select` in the cart's currency, and an unknown / unpriced variant
is rejected `409`.

## The order flow (`http/order.http`)

The order lifecycle spans both gateway controllers: **Place Order** is a cart
action (`cart.controller.ts`, since it acts on the cart) but produces an `Order`;
**read + capture** are order actions (`orders.controller.ts`).

| Request | Method + path | Notes |
|---|---|---|
| `login` | `POST /api/auth/customer/login` | captures `@accessToken` |
| `createCart` | `POST /api/cart` | captures `@cartId` |
| `addLineOne` | `POST /api/cart/:cartId/lines` | variant 1 @ `4999`, qty 2 |
| `addLineTwo` | `POST /api/cart/:cartId/lines` | variant 3 @ `19999`, qty 1 |
| `placeOrder` | `POST /api/cart/:cartId/place` | addresses + `paymentMethod?`; `Idempotency-Key`; captures `@orderId` |
| `getOrder` | `GET /api/orders/:orderId` | owner or staff `order:read` |
| `listMyOrders` | `GET /api/orders?page=1&pageSize=10` | own-only, newest-first |
| `capturePayment` | `POST /api/orders/:orderId/payments/capture` | `{ amountMinor? }`; `Idempotency-Key` |
| `placeOrderAgain` | `POST /api/cart/:cartId/place` | new key, same converted cart → same order |

`placeOrder` converts the cart one-shot: it snapshots each line from the catalog
(`sku` / `nameSnapshot` via `catalog.variant.get`, `unitPriceMinor` via
`catalog.price.select`), snapshots the billing + shipping addresses as immutable
`ownerType=order` copies, marks the cart `converted`, and authorizes payment
inline through the `PAYMENT_GATEWAY` (the always-approve fake). The `201`
`OrderView` carries `status=pending`, `paymentStatus=authorized`,
`fulfillmentStatus=unfulfilled`, the line snapshots, the totals
(`grandTotalMinor = 29997` for the two seeded lines), and the authorized
`payment`. `capturePayment` then walks the payment `authorized → captured`.

## Why a `.http` file per gateway area

The repository keeps **one `.http` file per gateway area** (`auth.http`,
`catalog.http`, `inventory.http`, `iam.http`, `pricing.http`, and these two) so
the file set mirrors the gateway module set, and a contributor changing one
controller knows exactly which file to update. Each file is self-contained — it
opens with its own prereqs + login and captures its own variables — so it can be
run in isolation. The files reference only seeded fixtures and runtime-captured
variables; they never hard-code an id that a migration or seed might not produce.

## Related documents

- [01 — Retail rebuild, old tables dropped](01-retail-rebuild-and-old-tables-dropped.md) — where the legacy `http/order.http` was removed before this rebuild re-created it.
- [02 — Cart aggregate and the Q1/Q3 decisions](02-cart-aggregate-and-q1-q3-decisions.md) — the cart operations + guest-promotion the cart file exercises.
- [03 — Order three status axes (Q4)](03-order-three-status-and-q4-decision.md) — the `OrderView` axes the order file asserts.
- [05 — Payment gateway port and the fake adapter](05-payment-gateway-port-and-fake-adapter.md) — the always-approve fake behind `placeOrder` / `capturePayment`.
- [07 — Authorize on place, capture explicit (Q5)](07-authorize-on-place-capture-explicit-q5.md) — the place + capture flow the order file drives.
- [08 — The `Idempotency-Key` header (Q10)](08-idempotency-key-header-q10.md) — why the header is accepted but not deduped.
- [09 — Routing keys retired and added](09-routing-keys-retired-and-added.md) — the RPC + event surface behind these HTTP routes.
- [ADR-024 — RBAC v2: StaffUser / Customer split](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) — why customer routes are owner-checked, not permission-gated.
- [ADR-028 — Cart / Order / Payment / Address chain](../../adr/028-cart-order-payment-and-address-chain.md) — the governing decision for the whole capability.
