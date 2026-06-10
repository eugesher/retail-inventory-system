# Carryover 05 — Cart operations end-to-end + gateway `modules/cart/` + guest-cart promotion

## Entry state for task-06

The retail microservice's **mutable cart side is fully operational** end to end —
domain (task-02) + the six **cart operations** + their RPC handlers + the reserved
event emits + the gateway HTTP surface + the guest-cart path. The `orders` module
(task-03/04) remains **foundation only** (no use cases/handlers/gateway). The
retail service now binds **six `@MessagePattern` cart command handlers** on
`retail_queue` (it previously had none).

### Retail cart use cases (`apps/retail-microservice/src/modules/cart/application/use-cases/`)

All take the wire command payload as `execute(payload)` (correlationId is inside
the payload — `ICorrelationPayload`), log `correlationId` inline (ADR-011), and
return a `CartView`. A shared `loadOwnedCart(repo, cartId, customerId)` helper
(`cart-access.ts`) does the retail-side owner-check: missing → `CART_NOT_FOUND`
(404), non-owner → `CART_ACCESS_FORBIDDEN` (403).

- **`CreateCartUseCase`** — `IRetailCartCreatePayload { customerId, currency?, correlationId }`;
  defaults `currency`→`'USD'`; `Cart.create` → `save` → emits `retail.cart.created`.
- **`GetCartUseCase`** — `IRetailCartGetPayload { cartId, customerId, correlationId }`;
  `loadOwnedCart` → view.
- **`AddToCartUseCase`** — `IRetailCartAddLinePayload { cartId, customerId, variantId, quantity, correlationId }`;
  `loadOwnedCart` → `catalog.selectApplicablePrice(variantId, cart.currency)` →
  **`null` ⇒ reject `CART_VARIANT_NOT_PRICED` (409)** → `cart.addLine({ …,
  unitPriceSnapshotMinor: price.amountMinor, currencySnapshot: cart.currency })` →
  `save` → emits `retail.cart.line-added`.
- **`ChangeCartLineQuantityUseCase`** — `IRetailCartChangeLineQuantityPayload { cartId, customerId, lineId, quantity, correlationId }`;
  `cart.changeLineQuantity` (`0` rejected `CART_LINE_QUANTITY_INVALID`) → `save` →
  emits `retail.cart.line-quantity-changed`.
- **`RemoveFromCartUseCase`** — `IRetailCartRemoveLinePayload { cartId, customerId, lineId, correlationId }`;
  `cart.removeLine` (unknown → `CART_LINE_NOT_FOUND`) → `save` → emits
  `retail.cart.line-removed`.
- **`ClaimCartUseCase`** — `IRetailCartClaimPayload { cartId, fromCustomerId, newCustomerId, correlationId }`;
  `loadOwnedCart(repo, cartId, fromCustomerId)` (the ownership **proof** — reuses
  the owner-check with `fromCustomerId` as owner) → `repo.reassignCustomer(cartId,
  newCustomerId)` → re-read → view. No event.

Publish failures are **warn-logged and swallowed** (ADR-020) — the cart write has
already committed. Each use case drains `cart.pullDomainEvents()[0]?.occurredAt`
for the wire event's `occurredAt`; the wire payload is otherwise built from inputs.

### New error codes (`domain/cart.exception.ts`)

Added to `CartErrorCodeEnum`: `CART_NOT_FOUND` (404), `CART_ACCESS_FORBIDDEN`
(403), `CART_VARIANT_NOT_PRICED` (409). The presentation
`CartRpcExceptionFilter` (`APP_FILTER`) is a **total** `Record<CartErrorCodeEnum,
HttpStatus>` (exhaustive at compile time) → `{ statusCode, message, code }` the
gateway's `throwRpcError` resolves. **`throwRpcError` gained a `403 →
ForbiddenException` branch** (it previously mapped only 404/400/409).

### New retail-side ports + adapters

- **`ICartCatalogGatewayPort` (`CART_CATALOG_GATEWAY`)** —
  `selectApplicablePrice(variantId, currency, correlationId?): Promise<PriceView | null>`.
  Adapter `CartCatalogRabbitmqAdapter` (`infrastructure/messaging/`) sends
  `catalog.price.select` via the `CATALOG_MICROSERVICE` client (one of the module's
  two `ClientProxy` sites). `asOf` is left unset (catalog defaults to now).
- **`ICartEventsPublisherPort` (`CART_EVENTS_PUBLISHER`)** — four methods, each
  takes the **wire** event (`IRetailCart*Event`). Adapter `CartRabbitmqPublisher`
  emits via the `RETAIL_MICROSERVICE` client onto **`retail_queue`** (reserved
  surfaces, no consumer). Second `ClientProxy` site.

### Retail cart presentation + module wiring

- `presentation/cart.controller.ts` — six `@MessagePattern` handlers (one per cart
  command key), thin delegates.
- `presentation/cart-rpc-exception.filter.ts` — `@Catch(CartDomainException)`.
- `infrastructure/cart.module.ts` — now imports `MicroserviceClientCatalogModule`
  + `MicroserviceClientRetailModule`; provides the repo, the catalog adapter +
  `CART_CATALOG_GATEWAY`, the publisher + `CART_EVENTS_PUBLISHER`, the six use
  cases, the controller, and `{ provide: APP_FILTER, useClass: CartRpcExceptionFilter }`.

### Routing keys (six **command** keys added)

`ROUTING_KEYS` + `MicroserviceMessagePatternEnum` (+ routing-keys spec) gained:
`RETAIL_CART_CREATE`=`retail.cart.create`, `RETAIL_CART_GET`=`retail.cart.get`,
`RETAIL_CART_ADD_LINE`=`retail.cart.add-line`,
`RETAIL_CART_CHANGE_LINE_QUANTITY`=`retail.cart.change-line-quantity`,
`RETAIL_CART_REMOVE_LINE`=`retail.cart.remove-line`,
`RETAIL_CART_CLAIM`=`retail.cart.claim`. The four reserved **event** keys
(`retail.cart.created`/`.line-added`/`.line-removed`/`.line-quantity-changed`)
were already present from task-02 and now have producers.

### Contracts (`libs/contracts/retail/interfaces/`)

New `cart-command.interface.ts` (+ `interfaces/index.ts`, re-exported from the
retail barrel): the six `IRetailCart{Create,Get,AddLine,ChangeLineQuantity,RemoveLine,Claim}Payload`
RPC command contracts (each extends `ICorrelationPayload`). They are the single
source of truth shared by the gateway adapter and the retail use cases/controller.

### Gateway `modules/cart/` (`apps/api-gateway/src/modules/cart/`)

Per-module hexagonal, **no `domain/`** (ADR-009). `CART_GATEWAY_PORT` →
`ICartGatewayPort` (six methods); `CartRabbitmqAdapter` is the **sole `ClientProxy`
holder** (one `.send` per RPC, via the `RETAIL_MICROSERVICE` client); six thin use
cases (inject the port + `throwRpcError`); `presentation/cart.controller.ts` +
`presentation/dto/*` (`CreateCartRequestDto`, `AddLineRequestDto`,
`ChangeLineQuantityRequestDto`, `ClaimCartRequestDto`). Registered in gateway
`app.module.ts`. Routes (`@ApiTags('Cart')`, all `@ApiBearerAuth()`):

| Method | Path | Body | Owner-check |
|---|---|---|---|
| POST | `/api/cart` | `{ currency? }` | n/a (sets customerId = caller) |
| GET | `/api/cart/:cartId` | — | yes |
| POST | `/api/cart/:cartId/lines` | `{ variantId, quantity }` | yes |
| PATCH | `/api/cart/:cartId/lines/:lineId` | `{ quantity }` | yes |
| DELETE | `/api/cart/:cartId/lines/:lineId` | — | yes |
| POST | `/api/cart/:cartId/claim` | `{ fromCustomerId }` | proof |

**Authorization = bearer + owner-check, NO permission code (ADR-024/ADR-028 §7).**
The controller folds `@CurrentUser().id` into the command's `customerId` (claim:
into `newCustomerId`); the **retail use case is the single enforcement point** —
no redundant gateway-side cart load (avoids an extra round-trip + a TOCTOU race).
`cartId` is a string param (CHAR(36)); `lineId` uses `ParseIntPipe`. `POST /lines`
and `/claim` use `@HttpCode(200)`; `POST /api/cart` is `201`.

### Auth — guest session + guest-authenticatable

- **`CreateGuestSessionUseCase`** (`modules/auth/application/use-cases/`) — creates
  a `Customer` (`status='guest'`, `password_hash` NULL, synthetic email
  `guest-<uuid>@guest.local`), issues a customer-tier access+refresh pair
  (`roles:[] / permissions:[]`, `sub = guestId`), rotates the refresh hash like
  `LoginCustomerUseCase`. Returns `{ accessToken, refreshToken, expiresIn, customerId }`.
- **`POST /auth/customer/guest-session`** (`@Public()`, `customer-auth.controller.ts`)
  → `GuestSessionResponseDto` (extends `TokenResponseDto` + `customerId`).
- **Guest authenticatable:** the customer port's `existsActiveById` was **renamed**
  to `existsAuthenticatableById` (`status IN ('active','guest')`, via `In([...])`
  in `CustomerTypeormRepository`); `ValidateJwtSubjectUseCase` points at it. The
  staff `existsActiveById` is unchanged. The auth in-memory customer double was
  updated (`active || guest`). (The `iam` test-doubles' `existsActiveById` is the
  **staff** double — untouched.)

### Guest cart promotion (claim) — Q1/Q7

A guest is a real, logged-in-able `Customer` row (Q7: every cart has a Customer
row). The guest builds a cart through the same bearer-protected routes. To promote:
`POST /api/cart/:cartId/claim` with the **registered** customer's token + body
`{ fromCustomerId: <guest id from the guest-session response> }` — knowing the
guest id is the **ownership proof**. The cart re-points only if `cart.customerId
=== fromCustomerId`; the new owner is `@CurrentUser().id`. Afterward the registered
token resolves the cart and the guest token gets `403` (ownership moved).
Auto-promotion-on-login is a later refinement (documented in doc 02).

## Files added / modified

**Added**
- Retail cart: `application/ports/{cart-catalog.gateway,cart-events.publisher}.port.ts`;
  `application/use-cases/{create-cart,get-cart,add-to-cart,change-cart-line-quantity,remove-from-cart,claim-cart}.use-case.ts` + `cart-access.ts` + `cart-view.factory.ts` + `index.ts` + `spec/{6 specs}.ts` + `spec/test-doubles.ts`;
  `infrastructure/messaging/{cart-catalog.rabbitmq.adapter,cart-rabbitmq.publisher}.ts` + `index.ts`;
  `presentation/{cart.controller,cart-rpc-exception.filter}.ts` + `index.ts`.
- Gateway cart: full `apps/api-gateway/src/modules/cart/` tree (`application/ports/*`,
  `application/use-cases/*`, `infrastructure/messaging/cart-rabbitmq.adapter.ts`,
  `presentation/cart.controller.ts` + `presentation/dto/*`, `cart.module.ts`, `index.ts`).
- Auth: `application/use-cases/create-guest-session.use-case.ts` + its spec;
  `presentation/dto/guest-session.response.dto.ts`.
- Contracts: `libs/contracts/retail/interfaces/cart-command.interface.ts` + `interfaces/index.ts`.
- `http/cart.http`; `test/cart-operations.e2e-spec.ts`; `test/guest-cart-promotion.e2e-spec.ts`.

**Modified**
- `libs/messaging/routing-keys.constants.ts` + `spec/routing-keys.constants.spec.ts`;
  `libs/contracts/microservices/microservice-message-pattern.enum.ts` (six command keys).
- `libs/contracts/retail/index.ts` (re-export `interfaces`); `domain/cart.exception.ts` (three codes).
- `apps/retail-microservice/.../cart/application/ports/index.ts`, `infrastructure/cart.module.ts`.
- `apps/api-gateway/src/app/app.module.ts` (import `CartModule`).
- `apps/api-gateway/.../common/utils/throw-rpc-error.util.ts` (403 branch).
- Auth: `customer.repository.port.ts` (`existsAuthenticatableById`),
  `customer-typeorm.repository.ts` (`In(['active','guest'])`),
  `validate-jwt-subject.use-case.ts`, `application/use-cases/index.ts`, `auth.module.ts`,
  `presentation/customer-auth.controller.ts`, `presentation/dto/index.ts`,
  `application/use-cases/spec/test-doubles.ts` (rename + guest logic),
  `application/use-cases/spec/validate-jwt-subject.use-case.spec.ts` (guest test).
- `docs/implementation/05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md`
  (Q1 guest-promotion + operations + bearer-owner-check sections — the placeholder is filled).
- `README.md` + `CLAUDE.md` (services table, system diagram routes, retail/cart/auth
  sections, contracts sub-area). **CLAUDE.md is git-excluded** — edits on disk, not in `git status`.

No new migration (no schema change). No ADR introduced — ADR-028/ADR-024 govern.

## Key decisions & deviations (task-06+ must respect)

- **Single owner-check enforcement point (retail), gateway forwards identity.** The
  task described a gateway-side load-and-compare; instead the gateway binds
  `customerId := @CurrentUser().id` and the retail use case enforces it. This is
  secure (identity comes only from the verified JWT), avoids an extra RPC, and
  dodges a TOCTOU race. `throwRpcError` now maps the retail `403`.
- **`CART_VARIANT_NOT_PRICED` is a 409** (not 404/400) — the variant cannot be
  added in its current pricing state.
- **`existsActiveById` → `existsAuthenticatableById` on the CUSTOMER port only**
  (renamed, not added — it was customer-validator-only). The staff port keeps
  `existsActiveById`.
- **Guest synthetic email** `guest-<uuid>@guest.local` satisfies the `Customer`
  email invariant + `UNIQUE(email)` without being deliverable.
- **Cart command payloads live in `libs/contracts/retail/interfaces/`** (new
  sub-dir) — the shared source of truth for both ends (the catalog precedent).

## Known gaps / deferrals (each names its owning task)

- **Place Order** (cart → order snapshot, `markConverted`, `Address.forOrder`,
  authorize-on-place via `PAYMENT_GATEWAY`, `markPaymentAuthorized`,
  `retail.order.placed`, `findBySourceCartId` idempotency) → **task-06**.
- **Capture + Get Order + List My Orders**, the gateway **orders** module, the
  `order:capture` permission, owner-checked customer order reads, seed extension →
  **task-07**.
- **Notification re-point** (`retail.order.placed` consumer + re-added e2e) → **task-08**.
- README/CLAUDE full retail finalization → **task-09**.
- Cart **auto-promotion on login** (implicit merge) is a later refinement — not owned
  by this epic's walking skeleton.

## How to verify (all green as of this task)

- `yarn build` — all five apps compile.
- `yarn lint` — clean (`--max-warnings 0`).
- `yarn test:unit` — **626 pass** (was 605; +21: 6 cart use-case specs, the
  guest-session spec, the validate-jwt-subject guest test).
- `yarn test:e2e` — full infra reload (`down -v` → up → migrate → seed) + **99 e2e
  pass** (12 suites; was 88/10 — `cart-operations` + `guest-cart-promotion` are
  green; both boot gateway + retail + catalog).
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ migrations/ README.md CLAUDE.md`.
- **`http/cart.http` sequence** (after `docker compose up -d && yarn migration:run &&
  yarn test:seed && yarn start:dev`):
  1. `login` (customer@example.com / customer1234) → captures `@accessToken`.
  2. `createCart` → `@cartId`; `getCart`; `addLine` (variantId 1, qty 2 → line
     `unitPriceSnapshotMinor` 4999); `changeLineQuantity` (→ 1); `removeLine` (→ empty).
  3. Guest flow: `guestSession` → `@guestAccessToken` + `@guestCustomerId`;
     `guestCreateCart` → `@guestCartId`; `claimCart` (registered token + `fromCustomerId`).
- Owner-check / auth: a second customer GETting the first's cart → `403`; an
  anonymous create/get → `401` (both asserted in `cart-operations.e2e-spec.ts`).
