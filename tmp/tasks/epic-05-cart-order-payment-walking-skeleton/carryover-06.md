# Carryover 06 — Place Order: cross-service snapshots, authorize-on-place, events, gateway place endpoint

## Entry state for task-07

Place Order is **live end to end**. `POST /api/cart/:cartId/place` converts an
`active` cart into an immutable `Order` one-shot, snapshots the lines + addresses,
authorizes payment inline, and returns the `OrderView`. The retail service now binds
**seven** RPC handlers on `retail_queue` (the six cart commands + the new
`retail.cart.place`, served by the orders controller). The `orders` module is no
longer foundation-only.

### `PlaceOrderUseCase` (`apps/retail-microservice/.../orders/application/use-cases/place-order.use-case.ts`)

Input: `IPlaceOrderPayload { cartId, customerId, shippingAddress, billingAddress,
paymentMethod?, idempotencyKey?, correlationId }`. Flow:

1. **Owner + state guard** via `ORDER_CART_READER` (see below) — `findCart(cartId)`:
   missing → `ORDER_CART_NOT_FOUND` (404); `cart.customerId !== customerId` →
   `ORDER_CART_ACCESS_FORBIDDEN` (403); `converted` → **repeat-place idempotency**
   (returns the existing order via `findBySourceCartId` + its payment, no duplicate);
   `abandoned` → `ORDER_CART_NOT_PLACEABLE` (409); empty → `ORDER_CART_EMPTY` (409).
2. **Snapshot lines** (read-only, no tx): per cart line, `Promise.all([getVariant,
   selectApplicablePrice])`. `sku = variant.sku`; `nameSnapshot` = **composed**
   `${product.name} (k: v, …)` (sorted option values, documented); `unitPriceMinor =
   price.amountMinor`; `null` price → `ORDER_LINE_NO_PRICE` (409); tax/discount = 0.
3. **Persist transactionally** (`TRANSACTION_PORT.runInTransaction`): `Order.place(…,
   billingAddressId: null, shippingAddressId: null …)` → `orderRepo.save(order,
   scope)` (assigns id + `order_number`) → `Address.forOrder({ orderId:
   String(orderId), … })` ×2 → `addressRepo.save(…, scope)` ×2 →
   `orderRepo.attachAddresses(orderId, billingId, shippingId, scope)` →
   `cartReader.markConverted(cartId, scope)`. **Ordering chosen + documented:**
   order-first (NULL address FKs) → addresses (FK-less `owner_id = order id`) → patch
   the order's address FKs. The order FKs onto `address`, so the address rows must
   precede the pointer; the targeted UPDATE mirrors `order_number` finalization.
4. **Authorize** via `AuthorizePaymentUseCase` (the gateway call is **outside** the
   tx; the Payment + `paymentStatus` advance commit in its own short follow-up tx).
5. **Re-read** the order (`findById`, post-commit) → `toOrderView(order, payment)`.
6. **Emit** `retail.order.placed` + `retail.payment.authorized` best-effort
   post-commit (warn-and-swallow, ADR-020). `idempotencyKey` logged, **not deduped**.

### `AuthorizePaymentUseCase` (`authorize-payment.use-case.ts`)

Input: `{ orderId, amountMinor, currency, method?, correlationId }`. Calls
`PAYMENT_GATEWAY.authorize(...)`; `!approved` → `ORDER_PAYMENT_NOT_APPROVED` (409,
order stays `paymentStatus=none`). On approval, in **one short tx**:
`Payment.authorized(...)` → `paymentRepo.save(scope)` → `orderRepo.findById(orderId,
scope)` → `order.markPaymentAuthorized()` → `orderRepo.save(scope)`. Returns the
`Payment`. Unit-tested against the fake gateway (approve + decline).

### New ports (`orders/application/ports/`)

- **`TRANSACTION_PORT`** (`ITransactionPort`, opaque `ITransactionScope` brand) —
  mirrors inventory `modules/stock` exactly; adapter `TypeormTransactionAdapter`.
- **`ORDER_CART_READER`** (`IOrderCartReaderPort` — `findCart` / `markConverted`,
  with `IOrderCartSnapshot`) — the orders module's seam onto the **cart** tables.
  **Key deviation (respect):** the boundaries lint forbids the orders module from
  importing the cart module's `ICartRepositoryPort` / `Cart` (cross-module). So the
  adapter `CartReaderTypeormAdapter` reads/`markConverted`s `cart`/`cart_line` via
  **raw parameterized SQL** through an injected `EntityManager` (no cart-entity
  import) — the exact precedent pricing uses for the catalog-owned
  `product_variant.tax_category_id`. The task said "load the cart via
  `ICartRepositoryPort.findById`"; that would violate ADR-017, hence this seam.
- **`ORDER_CATALOG_GATEWAY`** (`IOrderCatalogGatewayPort` — `getVariant` /
  `selectApplicablePrice`) — adapter `OrderCatalogRabbitmqAdapter` via the
  `CATALOG_MICROSERVICE` client (`catalog.variant.get` + `catalog.price.select`).
- **`ORDER_EVENTS_PUBLISHER`** (`IOrderEventsPublisherPort` — `publishOrderPlaced` /
  `publishPaymentAuthorized`) — adapter `OrderRabbitmqPublisher` holds **two**
  clients: `NOTIFICATION_MICROSERVICE` (→ `notification_events` for
  `retail.order.placed`) + `RETAIL_MICROSERVICE` (→ `retail_queue` for
  `retail.payment.authorized`).

### Repository changes (scope-aware)

`IOrderRepositoryPort.save(order, scope?)` + new `attachAddresses(orderId,
billingAddressId, shippingAddressId, scope?)` + `findById(id, scope?)`.
`IAddressRepositoryPort.save(address, scope?)` and
`IPaymentRepositoryPort.save(payment, scope?)` gained the optional scope. Each
TypeORM repo resolves a scoped repository when a scope is supplied (the
`EntityManager` downcast lives only in the repos + the transaction adapter, ADR-017
§6). `OrderTypeormRepository.save` was refactored to `persistGraph(manager, order)` +
re-read, joining the caller's transaction when scoped, else opening its own.

### New routing keys + queues

`ROUTING_KEYS` + `MicroserviceMessagePatternEnum` (+ the routing-keys spec) gained:
- `RETAIL_CART_PLACE = 'retail.cart.place'` (RPC, gateway → retail, served by the
  orders controller).
- `RETAIL_ORDER_PLACED = 'retail.order.placed'` (event → `notification_events`).
- `RETAIL_PAYMENT_AUTHORIZED = 'retail.payment.authorized'` (event → `retail_queue`,
  reserved).

### New contracts (`libs/contracts/retail`)

- `events/order-placed.event.ts` → `IRetailOrderPlacedEvent { orderId, orderNumber,
  customerId, grandTotalMinor, currency, lineCount, eventVersion:'v1', occurredAt }`.
- `events/payment-authorized.event.ts` → `IRetailPaymentAuthorizedEvent { orderId,
  paymentId, amountMinor, currency, eventVersion:'v1', occurredAt }`.
- `interfaces/place-order.interface.ts` → `IPlaceOrderPayload` + `IAddressInput`
  (recipientName, line1, line2?, city, region, postalCode, country, phone?).

### Gateway place endpoint (`apps/api-gateway/src/modules/cart/`)

- `POST /api/cart/:cartId/place` — bearer + owner-check (the controller folds
  `@CurrentUser().id` into `customerId`); body `PlaceOrderRequestDto` (nested
  `AddressInputDto` ×2, class-validated, `country` 2-char); the `Idempotency-Key`
  header read via `@Headers('idempotency-key')` (forwarded, not enforced). Returns
  the `OrderView` `201`.
- `ICartGatewayPort` gained `placeOrder(command, correlationId)` (+ `ICartPlaceCommand`);
  `CartRabbitmqAdapter.placeOrder` sends `retail.cart.place`. New `PlaceCartOrderUseCase`.

### Presentation + module wiring

- `orders/presentation/orders.controller.ts` (`@MessagePattern(RETAIL_CART_PLACE)`) +
  `orders-rpc-exception.filter.ts` (`APP_FILTER`, **total** `Record<OrderErrorCodeEnum,
  HttpStatus>`). New `OrderErrorCodeEnum` codes: `ORDER_NOT_FOUND`,
  `ORDER_CART_NOT_FOUND`, `ORDER_CART_ACCESS_FORBIDDEN`, `ORDER_CART_NOT_PLACEABLE`,
  `ORDER_CART_EMPTY`, `ORDER_LINE_NO_PRICE`, `ORDER_PAYMENT_NOT_APPROVED`.
- `orders.module.ts` imports `MicroserviceClientCatalogModule` +
  `MicroserviceClientNotificationModule` + `MicroserviceClientRetailModule`; registers
  the two use cases, the transaction/cart-reader/catalog/events adapters + their port
  bindings, the controller, and the filter.

## Key decisions & deviations (task-07+ must respect)

- **Cart access is raw-SQL, NOT a cart-module import** (the boundaries red line).
  task-07's read/capture must not import the cart module either.
- **`order_number` is finalized in the repo from the generated id**; `Order.place`
  receives a throwaway provisional (`'PENDING'`), overwritten on insert. The
  `nextOrderNumber()` preview is non-binding.
- **Address ordering: order-first → addresses → patch FKs** (documented in doc 04/the
  repo). `attachAddresses` is a targeted UPDATE; it does not bump `@VersionColumn`.
- **Payment non-approval → 409** (`throwRpcError` has no 402 branch); the order stays
  placed-but-unpaid.
- **`nameSnapshot` composes option values** (`Aurora Desk Lamp (color: warm-white)`),
  sorted keys; the e2e asserts `toContain(productName)` to stay robust.
- **The e2e observes events via a publisher spy** (`retailMicroservice.get(
  OrderRabbitmqPublisher).publishOrderPlaced/…`), since `useExisting` makes the class
  the same instance as `ORDER_EVENTS_PUBLISHER` (no broker-probe needed).

## Known gaps / deferrals (each names its owning task)

- **Capture + Get Order + List My Orders**, the gateway **orders** module, the
  `order:capture` permission, owner-checked customer order reads, seed extension,
  the `http/order.http` rewrite (GET/capture requests), e2e steps 6–8 → **task-07**.
  (`http/order.http` was **started** here with the place flow.)
- **Notification re-point** (the active `retail.order.placed` consumer + a re-added
  notification e2e) → **task-08**.
- README/CLAUDE full retail finalization + lint fixtures → **task-09**.
- True `Idempotency-Key` dedupe (a persisted idempotency store) → a later
  idempotency-persistence capability (doc 08).

## How to verify (all green as of this task)

- `yarn build` — all five apps compile.
- `yarn lint` — clean (`--max-warnings 0`).
- `yarn test:unit` — **636 pass** (was 626; +10 from the place/authorize specs).
- `yarn test:e2e` (infra reload + migrate + seed) — boots gateway + retail + catalog;
  `cart-to-order-walking-skeleton.e2e-spec.ts` logs in the seeded customer, builds a
  two-line cart (variant 1 ×2 @ 4999, variant 3 ×1 @ 19999 → grand 29997), places it,
  asserts `orderNumber` / `status=pending` / `paymentStatus=authorized` /
  `fulfillmentStatus=unfulfilled` + the line snapshots (`sku`, `nameSnapshot`,
  `unitPriceMinor`) + the authorized `payment`, asserts both events published (spy),
  and asserts the repeat-place returns the same order.
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- **No new migration** (no schema change — the four order tables already exist).
- `http/order.http`: run `login` → `createCart` → `addLineOne` → `addLineTwo` →
  `placeOrder` (with an `Idempotency-Key` header) after
  `docker compose up -d && yarn migration:run && yarn test:seed && yarn start:dev`.
