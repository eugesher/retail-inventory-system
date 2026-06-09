---
epic: epic-05
task_number: 6
title: Place Order — cross-service snapshots, authorize payment, events, gateway place endpoint, Idempotency-Key (Q10)
depends_on: [1, 2, 3, 4, 5]
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/04-order-line-snapshot-and-cross-service-lookup.md
---

# Task 06 — Place Order: cross-service snapshots, authorize payment, events, gateway place endpoint

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-028** (one-shot conversion at place-time (Q3); authorize-on-place
(Q5); the snapshot is the contract; `Idempotency-Key` accepted but not deduped (Q10),
repeat-place idempotency via cart state + `source_cart_id`), **ADR-026** (Select
Applicable Price: `amountMinor` is integer minor units; resolution lives in the
pricing use case — the retail side just consumes `catalog.price.select`), **ADR-025**
(variant metadata via `catalog.variant.get`; the variant is the backbone key),
**ADR-009** (gateway port-and-adapter; `ClientProxy` only in `infrastructure/messaging`),
**ADR-017/ADR-019** (transactional work via an `ITransactionPort` with an opaque
`ITransactionScope` — mirror the inventory `modules/stock` transaction adapter;
use cases stay TypeORM-free), **ADR-020** (post-commit event publish is best-effort,
warn-and-swallow), **ADR-001/ADR-011** (cross-service wire events are plain
`ICorrelationPayload` interfaces; log `correlationId` inline).

## Goal

Implement Place Order: convert an `active` cart to an immutable `Order` in one shot,
snapshotting each `OrderLine`'s `sku` / `nameSnapshot` / `unitPriceMinor` /
`taxAmountMinor` / `lineTotalMinor` from the catalog (`catalog.variant.get` +
`catalog.price.select`) at write-time, snapshotting billing + shipping `Address`
copies from the request body, authorizing payment inline via the `PAYMENT_GATEWAY`
port, and emitting `retail.order.placed` + `retail.payment.authorized`. Front it at
`POST /api/cart/:cartId/place` with an accepted-but-not-deduped `Idempotency-Key`
header (Q10).

## Entry state assumed

- task-01–05 complete. Cart operations are live end-to-end; the `orders/` module has
  `Order`/`OrderLine`/`Address`/`Payment` domain + persistence + repositories +
  the `PAYMENT_GATEWAY` (`FakePaymentGatewayAdapter`) binding; `Order.place(...)`,
  `Order.markPaymentAuthorized()`, `Payment.authorized(...)`, `Address.forOrder(...)`,
  `IOrderRepositoryPort.findBySourceCartId` + `nextOrderNumber`(or the derivation)
  exist; `Cart.markConverted()` + `ICartRepositoryPort` exist.
- The catalog microservice answers `catalog.variant.get`
  (`IGetVariantQuery{ variantId, correlationId }` → `VariantWithProductView` with
  `sku`, `optionValues`, `status`, `product{ id, name, slug, … }`) and
  `catalog.price.select` (`IPriceQuery` → `PriceView | null`) on `catalog_queue`.
- The gateway `modules/cart/` exists with the cart routes + the cart RMQ adapter.

## Place Order use case (retail — `apps/.../orders/application/use-cases/place-order.use-case.ts`)

Input: `{ cartId, customerId, shippingAddress, billingAddress, paymentMethod?,
idempotencyKey?, correlationId }` where `shippingAddress`/`billingAddress` are the
address field bundles from the request body.

Steps:
1. **Owner + state guard.** Load the cart (`ICartRepositoryPort.findById`). Reject
   `404` if missing; `403` if `cart.customerId !== customerId`; if the cart is
   already `converted`, **return the existing order** via
   `IOrderRepositoryPort.findBySourceCartId(cartId)` (+ its payment) — this is the
   repeat-place idempotency (driven by cart state, not the `Idempotency-Key`). Reject
   `409` if the cart is `abandoned` or empty.
2. **Snapshot lines (read-only, no transaction).** For each `CartLine`: call
   `catalog.variant.get(variantId)` → `sku` + `nameSnapshot` (`product.name`; you may
   compose option values into the name — document the choice); call
   `catalog.price.select(variantId, cart.currency)` → reject `409`
   (`ORDER_LINE_NO_PRICE` or similar typed error → mapped to HTTP at the gateway) if
   `null`; `unitPriceMinor = price.amountMinor`. `taxAmountMinor = 0`,
   `discountAmountMinor = 0` (no tax/discount capability — ADR-026 tax category is a
   label only). `lineTotalMinor = unitPriceMinor × quantity`.
3. **Build + persist (transactional).** Inside a transaction (`TRANSACTION_PORT`):
   persist the two snapshot `Address`es (`Address.forOrder` — set `ownerId` to the
   order id after the order is saved, or persist addresses first with a placeholder
   then patch, or save the order, then addresses, then patch the order's
   `billing/shipping_address_id` — pick the cleanest ordering and document it); build
   the `Order` via `Order.place({ orderNumber, customerId, currency, lines,
   billingAddressId, shippingAddressId, sourceCartId: cartId, placedAt })`
   (`status=pending`, `paymentStatus=none`, `fulfillment=unfulfilled`); persist it;
   finalize `order_number` from the assigned id (the derivation from the foundation
   task); `cart.markConverted()` + save.
4. **Authorize payment (inline, Q5).** Call `AuthorizePaymentUseCase` (below) with the
   order id + `grandTotalMinor` + currency + `paymentMethod`. On approval it persists
   the `Payment` (`authorized`) and advances `Order.markPaymentAuthorized()` (saved).
5. **Emit events post-commit (best-effort):** `retail.order.placed`
   `{ orderId, orderNumber, customerId, grandTotalMinor, currency, lineCount,
   eventVersion:'v1', occurredAt, correlationId }` → `notification_events` (active
   consumer arrives in the notification re-point task); `retail.payment.authorized`
   `{ orderId, paymentId, amountMinor, currency, eventVersion:'v1', occurredAt,
   correlationId }` → `retail_queue` (reserved). Log the `Idempotency-Key` inline;
   **do not** dedupe on it (Q10 — a later idempotency-persistence capability owns
   dedupe).
6. Return an `OrderView` (header + lines + the authorized `payment`).

> **Transaction shape:** add an `ITransactionPort` (`TRANSACTION_PORT`) +
> `TypeormTransactionAdapter` to `orders/` mirroring the inventory `modules/stock`
> implementation exactly (opaque `ITransactionScope`; the `EntityManager` downcast
> lives only in the adapter + the repositories — ADR-017 §6 / ADR-019). The
> repositories' `save` accepts an optional `ITransactionScope` so step 3's writes
> share one transaction. The external `PAYMENT_GATEWAY.authorize` call is **not**
> inside the DB transaction (it is an out-of-process call); persist the `Payment` +
> the `paymentStatus` advance in a short follow-up transaction after authorize
> returns.

## Authorize Payment use case (retail — `authorize-payment.use-case.ts`)

Input: `{ orderId, amountMinor, currency, method?, correlationId }`. Calls
`PAYMENT_GATEWAY.authorize(...)`. On `approved`: `Payment.authorized({ orderId,
amountMinor, currency, method: result.method, gatewayReference: result.gatewayReference,
authorizedAt: result.authorizedAt })`, persist via `IPaymentRepositoryPort`; load the
order, `markPaymentAuthorized()`, save. Returns the `Payment`. (On a non-approval —
unreachable with the fake, but model it — leave the order `paymentStatus=none` and
surface a typed error; the e2e uses the always-approve fake.) This use case is
unit-tested against a fake `PAYMENT_GATEWAY` (the epic's `authorize-payment` spec).

## Order catalog gateway port (snapshot reads)

`IOrderCatalogGatewayPort` (`ORDER_CATALOG_GATEWAY`;
`apps/.../orders/application/ports/order-catalog.gateway.port.ts`):
`getVariant(variantId, correlationId?): Promise<VariantWithProductView>` (rejects if
the variant is unresolvable) and `selectApplicablePrice(variantId, currency,
correlationId?): Promise<PriceView | null>`. Adapter `OrderCatalogRabbitmqAdapter`
(`orders/infrastructure/messaging/`, the only catalog `ClientProxy` site here) sends
`catalog.variant.get` + `catalog.price.select` via the `CATALOG_MICROSERVICE` client;
the `orders/` module imports `MicroserviceClientCatalogModule`.

## Order events publisher

`IOrderEventsPublisherPort` (`ORDER_EVENTS_PUBLISHER`) + `OrderRabbitmqPublisher`
(`orders/infrastructure/messaging/`): `publishOrderPlaced` emits `retail.order.placed`
via the `NOTIFICATION_MICROSERVICE` client onto `notification_events`;
`publishPaymentAuthorized` emits `retail.payment.authorized` via the
`RETAIL_MICROSERVICE` client onto `retail_queue` (reserved). The `orders/` module
imports `MicroserviceClientNotificationModule` + `MicroserviceClientRetailModule`.
Publish failures warn-and-swallow (ADR-020).

## Routing keys + contracts

Add to `ROUTING_KEYS` (+ `MicroserviceMessagePatternEnum` + the routing-keys spec):
- `RETAIL_CART_PLACE: 'retail.cart.place'` (RPC, gateway → retail)
- `RETAIL_ORDER_PLACED: 'retail.order.placed'` (event → notification)
- `RETAIL_PAYMENT_AUTHORIZED: 'retail.payment.authorized'` (event, reserved)

New wire contracts in `libs/contracts/retail/events/`:
- `IRetailOrderPlacedEvent extends ICorrelationPayload`
  `{ orderId, orderNumber, customerId, grandTotalMinor, currency, lineCount,
  eventVersion:'v1', occurredAt }`.
- `IRetailPaymentAuthorizedEvent extends ICorrelationPayload`
  `{ orderId, paymentId, amountMinor, currency, eventVersion:'v1', occurredAt }`.

Add the place request payload contract: `IPlaceOrderPayload extends ICorrelationPayload`
`{ cartId, customerId, shippingAddress: IAddressInput, billingAddress: IAddressInput,
paymentMethod?, idempotencyKey? }` and an `IAddressInput` (recipientName, line1,
line2?, city, region, postalCode, country, phone?). Place returns `OrderView`.

## Gateway place endpoint (extend `modules/cart/`)

- `POST /api/cart/:cartId/place` — bearer; body `PlaceOrderRequestDto`
  (`{ shippingAddress, billingAddress, paymentMethod? }`, class-validated — country
  2-char, required address fields non-empty); **header** `Idempotency-Key: <uuid>`
  read via `@Headers('idempotency-key')` (accepted + forwarded, not enforced).
  Owner-check: the `customerId` sent on the RPC is `@CurrentUser().id` (the retail
  use case re-asserts ownership). Returns the `OrderView` (`201`).
- Extend `ICartGatewayPort` + the gateway cart RMQ adapter with `placeOrder(cartId,
  customerId, body, idempotencyKey, correlationId)` → `retail.cart.place`.
- Add a `PlaceCartOrderUseCase` (gateway) injecting the port.

## `http/order.http` (started here, rewritten in the read/capture task)

Add a `# @name placeOrder` request: `POST {{baseUrl}}/cart/{{cartId}}/place` with
`Authorization: Bearer {{accessToken}}`, an `Idempotency-Key:
{{$guid}}`-style header (kulala random-uuid), and a JSON body with `shippingAddress`
+ `billingAddress` + `paymentMethod`. A `# Prereqs:` block points at the seeded
customer login + a created cart with two lines (reuse `http/cart.http`'s flow). The
GET/capture requests are added in the read/capture task.

## Files to add

- `apps/.../orders/application/use-cases/place-order.use-case.ts`,
  `authorize-payment.use-case.ts` (+ `index.ts` + `spec/*` + `spec/test-doubles.ts`).
- `apps/.../orders/application/ports/order-catalog.gateway.port.ts`,
  `order-events.publisher.port.ts`, `transaction.port.ts` (update ports `index.ts`).
- `apps/.../orders/infrastructure/messaging/order-catalog.rabbitmq.adapter.ts`,
  `order-rabbitmq.publisher.ts`, `index.ts`.
- `apps/.../orders/infrastructure/persistence/typeorm-transaction.adapter.ts` (mirror
  inventory).
- `apps/.../orders/presentation/orders.controller.ts` (the `retail.cart.place`
  `@MessagePattern`).
- `apps/api-gateway/src/modules/cart/application/use-cases/place-cart-order.use-case.ts`,
  `presentation/dto/place-order.request.dto.ts`.
- `libs/contracts/retail/events/order-placed.event.ts`,
  `payment-authorized.event.ts`; `libs/contracts/retail/interfaces/place-order.interface.ts`
  (`IPlaceOrderPayload`, `IAddressInput`).
- `test/cart-to-order-walking-skeleton.e2e-spec.ts` (steps 1–5; extended in the
  read/capture task).
- `docs/implementation/05-cart-order-payment-walking-skeleton/04-order-line-snapshot-and-cross-service-lookup.md`,
  `07-authorize-on-place-capture-explicit-q5.md` (started),
  `08-idempotency-key-header-q10.md`.

## Files to modify

- `apps/.../orders/infrastructure/orders.module.ts` — register the two use cases, the
  catalog adapter + `ORDER_CATALOG_GATEWAY`, the publisher + `ORDER_EVENTS_PUBLISHER`,
  the transaction adapter + `TRANSACTION_PORT`, the controller; import
  `MicroserviceClientCatalogModule` + `MicroserviceClientNotificationModule` +
  `MicroserviceClientRetailModule`. The repositories' `save` gains an optional
  `ITransactionScope` arg.
- `apps/api-gateway/src/modules/cart/` — controller (place route), `ICartGatewayPort`
  + adapter (place method), use-cases barrel, DTO barrel, module providers.
- `libs/messaging/routing-keys.constants.ts` + `spec/routing-keys.constants.spec.ts`;
  `libs/contracts/microservices/microservice-message-pattern.enum.ts`.
- `libs/contracts/retail/{index,events/index,interfaces/index}.ts`.
- `http/order.http` (the place request; the file is fully rewritten in the
  read/capture task).

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`):
  - `place-order.use-case.spec.ts` — happy path: snapshots `sku`/`nameSnapshot` from
    a fake `ORDER_CATALOG_GATEWAY.getVariant` + `unitPriceMinor` from
    `selectApplicablePrice`; builds an `Order` (`pending`/`none`/`unfulfilled`) with
    correct totals (`grandTotal = Σ unitPrice×qty`, tax/discount/shipping `0`);
    snapshots two addresses; marks the cart `converted`; authorizes payment;
    emits `retail.order.placed` + `retail.payment.authorized`. Rejections: empty/
    abandoned cart `409`; non-owner `403`; a line with no applicable price `409`.
    Idempotency: a second `execute` on the now-`converted` cart returns the **same**
    order (via `findBySourceCartId`) and does **not** create a duplicate.
  - `authorize-payment.use-case.spec.ts` — against a fake `PAYMENT_GATEWAY`: persists
    a `Payment` in `authorized`, advances `Order.paymentStatus` to `authorized`,
    returns the payment; a non-approval leaves the order unpaid.
- **E2E** (`yarn test:e2e`) `test/cart-to-order-walking-skeleton.e2e-spec.ts`
  (steps 1–5; the read/capture task adds 6–8): log in the seeded customer; create a
  cart; add the two seeded variants; `POST /api/cart/:cartId/place` with addresses +
  an `Idempotency-Key`; assert the response carries `orderNumber`, `status='pending'`,
  `paymentStatus='authorized'`, `fulfillmentStatus='unfulfilled'`, and the line
  snapshots (`sku`, `nameSnapshot`, `unitPriceMinor`) match the catalog; assert
  `retail.order.placed` + `retail.payment.authorized` were published (observe via the
  broker or a spy, as `notification.e2e` does). Boots gateway + retail + catalog.

## Doc deliverable

Write three docs:

`04-order-line-snapshot-and-cross-service-lookup.md` — how Place Order fetches
variant metadata (`catalog.variant.get`) + the applicable price
(`catalog.price.select`) at write-time and **freezes** them onto the `OrderLine`; why
the snapshot — not the live catalog row — is the contract with the buyer (a later
price/name change must not rewrite a placed order); the cross-service RMQ ports +
the "no applicable price → reject" rule; that tax/discount/shipping are `0` in this
capability.

`07-authorize-on-place-capture-explicit-q5.md` — **started**: the **authorize-on-place**
half of Q5 (inline authorization via the `PAYMENT_GATEWAY` port; the `Payment` +
`Order.paymentStatus` advance; the transaction boundary vs. the out-of-process
gateway call). Leave a clearly marked "Explicit capture" section the read/capture
task completes.

`08-idempotency-key-header-q10.md` — Q10: the `Idempotency-Key` header is accepted +
forwarded + logged on Place (and, later, Capture) **but not deduped** in this
capability; the actual repeat-safety today comes from **cart-state idempotency**
(a placed cart is `converted`; re-placing returns the order it converted into, via
`source_cart_id`); true key-based dedupe (a local idempotency-key store) is a later
idempotency-persistence capability.

Cross-link `docs/adr/028-…md`, `docs/adr/026-…md`, `docs/adr/025-…md`. Describe
everything by capability — never by an epic/task number.

## Carryover to read

`carryover-01.md` … `carryover-05.md`.

## Carryover to produce

Write `carryover-06.md`. Capture: the `PlaceOrderUseCase` + `AuthorizePaymentUseCase`
contracts (the snapshot flow, the transaction boundary, the cart-state idempotency,
the `Idempotency-Key` accept-not-dedupe); the `IOrderCatalogGatewayPort` +
`IOrderEventsPublisherPort` + the orders `TRANSACTION_PORT`; the new keys
(`retail.cart.place` RPC, `retail.order.placed` + `retail.payment.authorized`
events) + their queues; the place request/response contracts (`IPlaceOrderPayload`,
`IAddressInput`, `OrderView` with `payment`); the gateway place route + the
`Idempotency-Key` header handling; the e2e steps 1–5. Deferrals: Capture + Get +
List + gateway orders module + `order:capture` + seed + `http/order.http` rewrite +
e2e steps 6–8 → task-07; the active notification consumer for `retail.order.placed`
→ task-08. List verify commands.

## Exit criteria

- [ ] `POST /api/cart/:cartId/place` converts the cart one-shot, snapshots lines +
      addresses, persists the `pending` order, authorizes payment inline
      (`paymentStatus=authorized`), and returns the `OrderView`.
- [ ] `OrderLine.sku` / `nameSnapshot` / `unitPriceMinor` are populated from the
      catalog at place-time; a line with no applicable price is rejected `409`.
- [ ] A repeat place on the now-`converted` cart returns the **same** order (no
      duplicate); the `Idempotency-Key` header is accepted + logged, not deduped.
- [ ] `retail.order.placed` (→ `notification_events`) + `retail.payment.authorized`
      (→ `retail_queue`) are published after a successful place.
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` + `yarn test:e2e`
      pass (`cart-to-order-walking-skeleton` steps 1–5 green).
- [ ] Docs `04`, `07` (started), `08` are written.
- [ ] The self-containment grep is clean.
- [ ] `carryover-06.md` is written.
