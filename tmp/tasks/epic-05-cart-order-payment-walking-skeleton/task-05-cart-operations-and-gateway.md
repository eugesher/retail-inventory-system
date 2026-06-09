---
epic: epic-05
task_number: 5
title: Cart operations end-to-end + gateway modules/cart + guest cart promotion (Q1/Q7)
depends_on: [1, 2, 3, 4]
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md
---

# Task 05 — Cart operations end-to-end + gateway `modules/cart/` + guest cart promotion

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-028** (Cart aggregate; Q1 guest carts; the customer
authorization model = bearer + owner-check, no customer permission code),
**ADR-009** (the gateway port-and-adapter split — `ClientProxy` only inside
`infrastructure/messaging/*-rabbitmq.adapter.ts`; controllers/use-cases/pipes inject
the port symbol; gateway modules other than `auth` hold no `domain/`), **ADR-024**
(customer tokens carry `roles:[] / permissions:[]`; `@CurrentUser()` returns
`ICurrentUser{ id, … }`; `@Public()` opts a route out of the global guards; guest
Customers self-register via the auth module), **ADR-008/ADR-020** (dotted RPC keys;
`ClientProxy.send` for RPC materialized with `firstValueFrom`; reserved-surface
events emit onto the producer's own queue), **ADR-003/ADR-011** (cross-service wire
events are plain `ICorrelationPayload` interfaces; log `correlationId` inline in
microservice handlers).

## Goal

Ship the cart operations end-to-end: the retail microservice's Add to Cart / Change
Quantity / Remove / Get Cart use cases (+ the cart RPC `@MessagePattern` handlers +
the reserved `retail.cart.*` event emits), and the gateway `modules/cart/` fronting
them over HTTP with **bearer + owner-check** authorization. Add the **guest cart**
path (Q1/Q7): a `@Public()` guest-session endpoint in the auth module mints a
guest-tier token; a `claim` endpoint promotes a guest cart to a registered customer.
Add `http/cart.http` and the two cart e2e specs.

## Entry state assumed

- task-01–04 complete. The retail `cart/` module has the `Cart`/`CartLine` domain +
  persistence + `ICartRepositoryPort` (`findById`, `save`, `reassignCustomer`); the
  four `retail.cart.*` reserved event keys + the cart `CartView`/`CartLineView`
  contracts exist. The `orders/` module has Order/OrderLine/Address/Payment
  foundations (no use cases). The gateway has **no** cart/order module. The catalog
  microservice answers `catalog.price.select` (`IPriceQuery{ variantId, currency,
  asOf?, correlationId }` → `PriceView | null`, `amountMinor` in minor units) on
  `catalog_queue`; `MicroserviceClientCatalogModule` + the `CATALOG_MICROSERVICE`
  client token exist in `libs/messaging`.
- The auth module exposes `CUSTOMER_REPOSITORY`, `TOKEN_SERVICE` (`ITokenPort`:
  `issueAccessToken`/`issueRefreshToken`/`accessTokenExpiresInSeconds`),
  `PASSWORD_HASHER`; `Customer` status enum is `active|suspended|guest|deleted`;
  `customer.password_hash` is nullable; `LoginCustomerUseCase` mints customer tokens
  with `roles:[] / permissions:[]`; `ValidateJwtSubjectUseCase.validate` confirms an
  active subject via `customers.existsActiveById`.
- The seeded customer is `customer@example.com` / `customer1234` (id
  `00000000-0000-4000-a000-000000000002`, status `active`); seeded variants exist
  (ids `1` / `2` per `catalog-product-variant.sql`) with USD prices (`price.sql`).

## Authorization model (read before coding)

- **All cart CRUD routes are default-protected (bearer required).** A customer-tier
  token (registered *or* guest) passes the global `JwtAuthGuard`; with no
  `@RequiresPermission`/`@Roles` on the route, `PermissionsGuard`/`RolesGuard` allow
  it (customers carry no permissions — ADR-024). The **owner-check is in the gateway
  use case**: compare `@CurrentUser().id` to the cart's `customerId`; mismatch →
  `403 Forbidden`. Do **not** add a `@RequiresPermission('customer:own-orders:read')`
  gate — it would reject the very customers it targets (ADR-024 / ADR-028).
- **Guest bootstrap** is the single `@Public()` exception: `POST /auth/customer/guest-session`
  mints a guest-tier token so the guest can then hit the protected cart routes
  uniformly.

## Guest cart + promotion (Q1/Q7)

This capability deviates, deliberately and documentedly, from the epic's
"session-cookie" wording: the system's auth primitive is the bearer token, so a
**guest-tier token** replaces the cookie. Mechanism:

1. **Guest session (auth module).** `POST /auth/customer/guest-session` — `@Public()`
   — `CreateGuestSessionUseCase` creates a `Customer` with `status='guest'` and a
   `null` `password_hash` (Q7: every cart/order has a Customer row, guest included),
   then issues a customer-tier access+refresh pair via `TOKEN_SERVICE` (claims
   `roles:[] / permissions:[]`, `sub = guestCustomerId`). Returns
   `{ accessToken, refreshToken, expiresIn, customerId }`. So that the guest token
   validates, make a **guest authenticatable**: extend the customer repository's
   active-subject check (`existsActiveById`, or add `existsAuthenticatableById`) to
   accept `status IN ('active','guest')` and reject `suspended`/`deleted`; point
   `ValidateJwtSubjectUseCase` at it. (A guest is a real logged-in-able row; only
   suspended/deleted are barred.)
2. **Build a cart as the guest** via the normal bearer-protected cart routes
   (`cart.customerId = guestId`).
3. **Promotion (claim).** `POST /api/cart/:cartId/claim` — default-protected (the
   **registered** customer's token) — body `{ fromCustomerId: string }`.
   `ClaimCartUseCase` (gateway) calls the retail `retail.cart.claim` RPC →
   `ClaimCartUseCase` (retail) loads the cart and, **only if** `cart.customerId ===
   fromCustomerId`, calls `repo.reassignCustomer(cartId, newCustomerId)` (else
   rejects). `fromCustomerId` is the guest id the client received from the
   guest-session response — knowing it proves the caller owned the guest session.
   Returns the updated `CartView`.

> Auto-promotion-on-login (the cart converting to the customer's own at login
> without an explicit claim) is a later refinement — note it in doc `02`. The
> explicit `claim` is the contained, testable walking-skeleton form.

## Use cases (retail microservice — `apps/.../cart/application/use-cases/`)

All log `correlationId` inline (ADR-001/ADR-011) and return a `CartView`.
- `CreateCartUseCase` — input `{ customerId, currency?, correlationId }`; defaults
  `currency` → `'USD'`; persists a new `active` `Cart`; emits `retail.cart.created`
  (reserved). Returns the `CartView`.
- `GetCartUseCase` — input `{ cartId, correlationId }`; returns the `CartView` or
  rejects `404` if missing. (Owner-check happens at the gateway use case, which has
  `@CurrentUser()`; the RPC payload carries the resolved `customerId` for the retail
  use case to assert too — see below.)
- `AddToCartUseCase` — input `{ cartId, variantId, quantity, correlationId }`; loads
  the cart; resolves the price via the catalog port (`catalog.price.select` with the
  cart's currency); **rejects if no applicable price** (unknown/unpriced variant);
  `cart.addLine({ variantId, quantity, unitPriceSnapshotMinor: price.amountMinor,
  currencySnapshot: cart.currency })`; saves; emits `retail.cart.line-added`. Returns
  the `CartView`.
- `ChangeCartLineQuantityUseCase` — `{ cartId, lineId, quantity, correlationId }`;
  `cart.changeLineQuantity`; saves; emits `retail.cart.line-quantity-changed`.
- `RemoveFromCartUseCase` — `{ cartId, lineId, correlationId }`; `cart.removeLine`;
  saves; emits `retail.cart.line-removed`.
- `ClaimCartUseCase` — `{ cartId, fromCustomerId, newCustomerId, correlationId }`;
  the guarded re-point above.

Owner-check on retail-side reads/writes: include the caller's `customerId` in the RPC
payload and have each retail use case assert `cart.customerId === payload.customerId`
(reject `403`-mapped error otherwise) **in addition** to the gateway owner-check — so
the retail service is not solely trusting the edge. (The gateway is the only caller,
but defense-in-depth is cheap here.)

### Cart catalog port (price snapshot)

`ICartCatalogGatewayPort` (`CART_CATALOG_GATEWAY`;
`apps/.../cart/application/ports/cart-catalog.gateway.port.ts`):
`selectApplicablePrice(variantId, currency, correlationId?): Promise<PriceView | null>`.
Adapter `CartCatalogRabbitmqAdapter`
(`apps/.../cart/infrastructure/messaging/cart-catalog.rabbitmq.adapter.ts`, the only
`ClientProxy` site here) sends `catalog.price.select` via the `CATALOG_MICROSERVICE`
client. The cart module imports `MicroserviceClientCatalogModule`.

### Cart events publisher

`ICartEventsPublisherPort` (`CART_EVENTS_PUBLISHER`) + `CartRabbitmqPublisher`
(`apps/.../cart/infrastructure/messaging/cart-rabbitmq.publisher.ts`) emit the four
`retail.cart.*` reserved events onto **`retail_queue`** (the producer's own queue —
no consumer yet) via the `RETAIL_MICROSERVICE` client. The cart module imports
`MicroserviceClientRetailModule`. Publish failures are `warn`-logged and swallowed
(ADR-020) — the cart write already committed.

## Cart RPC keys (gateway → retail)

Add to `ROUTING_KEYS` (+ `MicroserviceMessagePatternEnum` + the routing-keys spec):
- `RETAIL_CART_CREATE: 'retail.cart.create'`
- `RETAIL_CART_GET: 'retail.cart.get'`
- `RETAIL_CART_ADD_LINE: 'retail.cart.add-line'`
- `RETAIL_CART_CHANGE_LINE_QUANTITY: 'retail.cart.change-line-quantity'`
- `RETAIL_CART_REMOVE_LINE: 'retail.cart.remove-line'`
- `RETAIL_CART_CLAIM: 'retail.cart.claim'`

The retail `cart/presentation/cart.controller.ts` registers a `@MessagePattern` for
each, delegating to the matching use case.

## Gateway `modules/cart/`

Per-module hexagonal, **no `domain/`** (ADR-009). `application/ports`
(`CART_GATEWAY_PORT` → `ICartGatewayPort` with one method per cart RPC),
`application/use-cases` (thin gateway use cases that inject the port + apply the
owner-check), `infrastructure/messaging/cart-rabbitmq.adapter.ts` (the only
`ClientProxy` holder; one `.send` per RPC), `presentation/cart.controller.ts` +
`presentation/dto/*`. Routes (`@ApiTags('Cart')`):

| Method | Path | Body / params | Auth | Use case |
|---|---|---|---|---|
| `POST` | `/api/cart` | optional `{ currency }` | bearer (customer/guest) | CreateCart (`customerId = @CurrentUser().id`) |
| `GET` | `/api/cart/:cartId` | — | bearer + owner-check | GetCart |
| `POST` | `/api/cart/:cartId/lines` | `{ variantId, quantity }` | bearer + owner-check | AddToCart |
| `PATCH` | `/api/cart/:cartId/lines/:lineId` | `{ quantity }` | bearer + owner-check | ChangeCartLineQuantity |
| `DELETE` | `/api/cart/:cartId/lines/:lineId` | — | bearer + owner-check | RemoveFromCart |
| `POST` | `/api/cart/:cartId/claim` | `{ fromCustomerId }` | bearer (registered) | ClaimCart |

- The owner-check: the gateway use case (or a pipe) loads the cart via
  `GetCart`/the port, compares `cart.customerId` to `@CurrentUser().id`, throws
  `ForbiddenException` on mismatch — except `claim`, which uses the `fromCustomerId`
  proof instead. Pass `@CorrelationId()` through.
- DTOs use `class-validator` (`variantId` positive int; `quantity` positive int;
  `fromCustomerId` UUID string; `currency` optional 3-letter string).
- Register `CartModule` in the gateway `AppModule`.

## Auth module changes (guest session)

- Add `CreateGuestSessionUseCase`
  (`apps/api-gateway/src/modules/auth/application/use-cases/create-guest-session.use-case.ts`)
  — creates a guest `Customer` (status `guest`, null password) via `CUSTOMER_REPOSITORY`,
  issues tokens via `TOKEN_SERVICE`, rotates the refresh hash like
  `LoginCustomerUseCase`. (+ spec.)
- Add `POST /auth/customer/guest-session` (`@Public()`) to `customer-auth.controller.ts`
  returning `TokenResponseDto` extended with `customerId` (or a dedicated DTO).
- Make a guest authenticatable: update the customer repository's active-subject check
  + `ValidateJwtSubjectUseCase` to accept `status IN ('active','guest')`. Update the
  relevant spec(s).

## `http/cart.http` (new)

`@baseUrl = {{ENV_BASE_URL}}`; `###` separators; a `# @name` per request; header
comments citing the controller path + body shape. A `# Prereqs:` block: log in the
seeded customer (`POST /api/auth/customer/login` with `customer@example.com` /
`customer1234`), capture `@accessToken` from the response, and capture `@cartId`
from the `POST /api/cart` response. Requests: createCart, getCart, addLine
(`variantId:1, quantity:2`), changeLineQuantity, removeLine; plus a `guestSession`
(`POST /auth/customer/guest-session`) and a `claimCart` example documenting the
`fromCustomerId` proof. No `tmp/`/"epic"/"task" strings.

## Files to add

- Retail cart use cases (`create-cart`, `get-cart`, `add-to-cart`,
  `change-cart-line-quantity`, `remove-from-cart`, `claim-cart`) + `index.ts` +
  `spec/*` + `spec/test-doubles.ts`.
- `apps/.../cart/application/ports/cart-catalog.gateway.port.ts`,
  `cart-events.publisher.port.ts` (update ports `index.ts`).
- `apps/.../cart/infrastructure/messaging/cart-catalog.rabbitmq.adapter.ts`,
  `cart-rabbitmq.publisher.ts`, `index.ts`.
- `apps/.../cart/presentation/cart.controller.ts` (+ `index.ts`).
- Gateway `apps/api-gateway/src/modules/cart/` full tree (`application/ports/*`,
  `application/use-cases/*`, `infrastructure/messaging/cart-rabbitmq.adapter.ts`,
  `presentation/cart.controller.ts`, `presentation/dto/*`, `cart.module.ts`,
  `index.ts`).
- `apps/api-gateway/src/modules/auth/application/use-cases/create-guest-session.use-case.ts`
  (+ spec); a guest-session response DTO if needed.
- `http/cart.http`
- `test/cart-operations.e2e-spec.ts`, `test/guest-cart-promotion.e2e-spec.ts`
- (doc 02 is **modified**, not added — see below.)

## Files to modify

- `apps/.../cart/infrastructure/cart.module.ts` — register the use cases, the catalog
  adapter + `CART_CATALOG_GATEWAY`, the publisher + `CART_EVENTS_PUBLISHER`, the
  controller; import `MicroserviceClientCatalogModule` + `MicroserviceClientRetailModule`.
- `libs/messaging/routing-keys.constants.ts` + `spec/routing-keys.constants.spec.ts`;
  `libs/contracts/microservices/microservice-message-pattern.enum.ts` (the six cart
  RPC keys).
- `apps/api-gateway/src/app/app.module.ts` — import `CartModule`.
- `apps/api-gateway/src/modules/auth/presentation/customer-auth.controller.ts` +
  `application/use-cases/index.ts` + `auth.module.ts` (register
  `CreateGuestSessionUseCase`); the customer repository + `ValidateJwtSubjectUseCase`
  (+ spec) for guest-authenticatable.
- `docs/implementation/05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md`
  — fill in the **Q1 guest-promotion** section + the cart operations.

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`):
  - `add-to-cart.use-case.spec.ts` — happy path snapshots `unitPriceSnapshotMinor`
    from `catalog.price.select`; **no applicable price → rejected**; the line-added
    event is emitted; the owner-check (`cart.customerId !== payload.customerId`)
    rejects.
  - `remove-from-cart.use-case.spec.ts`, `change-cart-line-quantity.use-case.spec.ts`
    — mutate the right line, emit the right event, owner-check; quantity `0` rejected
    (removal is explicit).
  - `get-cart.use-case.spec.ts` — returns the view; `404` on missing.
  - `claim-cart.use-case.spec.ts` — re-points only when `cart.customerId ===
    fromCustomerId`; rejects otherwise.
  - `create-guest-session.use-case.spec.ts` (gateway/auth) — creates a `guest`
    Customer with null password + issues a token pair.
  - Use a `CART_CATALOG_GATEWAY` double returning a fixed `PriceView` (no live RMQ in
    unit tests).
- **E2E** (`yarn test:e2e`):
  - `test/cart-operations.e2e-spec.ts` — login the seeded customer; create a cart;
    add variant 1 (qty 2) → cart shows the line + snapshot price; change qty → 1;
    remove → empty; a **second customer cannot GET the first's cart** (`403`);
    creating/getting without a bearer → `401`.
  - `test/guest-cart-promotion.e2e-spec.ts` — `POST /auth/customer/guest-session` →
    guest token + `customerId`; create a cart + add a line with the guest token;
    register a new customer (`POST /auth/customer/register`) + log in → real token;
    `POST /api/cart/:cartId/claim` with the real token + `{ fromCustomerId: guestId }`;
    `GET /api/cart/:cartId` with the real token resolves (owner is now the new
    customer); the guest token can no longer read it (`403`).
- Both e2e specs boot the gateway + retail + catalog microservices (catalog answers
  `catalog.price.select`). Keep the seed idempotent.

## Doc deliverable

`02-cart-aggregate-and-q1-q3-decisions.md` — **complete** the doc started in the
cart-foundation work: fill the **Q1** section (guest carts get a real `Customer`
row with `status='guest'`, Q7; the guest-tier token replaces the epic's session
cookie and why; the `claim` promotion + the `fromCustomerId` proof; auto-on-login as
a later refinement) and document the cart operations (Add/Change/Remove/Get, the
add-time price snapshot via Select Applicable Price, the reserved `retail.cart.*`
events) and the **bearer + owner-check** authorization (and why no
`customer:own-orders:read` permission code — ADR-024). Cross-link `docs/adr/028-…md`
and `docs/adr/024-…md`. Describe everything by capability — never by an epic/task
number.

## Carryover to read

`carryover-01.md` … `carryover-04.md`.

## Carryover to produce

Write `carryover-05.md`. Capture: the six cart use-case contracts + their owner-check;
the six `retail.cart.*` RPC keys + the four reserved event keys; the
`ICartCatalogGatewayPort` (price.select) + `ICartEventsPublisherPort`; the gateway
`modules/cart/` routes + the bearer-owner-check model (no permission code); the auth
`guest-session` endpoint + `CreateGuestSessionUseCase` + the guest-authenticatable
change; the `claim` + `fromCustomerId` proof; `http/cart.http`; the two e2e specs.
Deferrals: Place Order → task-06; Capture + Get Order + List My Orders + gateway
orders module + `order:capture` + seed → task-07; notification re-point → task-08.
List verify commands incl. the full `http/cart.http` sequence + the guest flow.

## Exit criteria

- [ ] `POST /api/cart`, `GET /api/cart/:id`, `POST/PATCH/DELETE …/lines[/:lineId]`,
      and `POST …/claim` work end-to-end, bearer-protected with an owner-check;
      Add-to-Cart snapshots the applicable price and rejects an unpriced variant.
- [ ] `POST /auth/customer/guest-session` mints a guest-tier token; a guest cart is
      promotable to a registered customer via `claim`; the
      `guest-cart-promotion.e2e` is green.
- [ ] A non-owner gets `403`; an unauthenticated caller gets `401`; no customer
      permission code was introduced.
- [ ] The reserved `retail.cart.*` events publish onto `retail_queue`.
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` + `yarn test:e2e`
      pass (`cart-operations` + `guest-cart-promotion` green).
- [ ] Every `http/cart.http` request executes against the seeded customer + variants.
- [ ] `02-cart-aggregate-and-q1-q3-decisions.md` is completed (Q1 + operations).
- [ ] The self-containment grep is clean.
- [ ] `carryover-05.md` is written.
