---
epic: epic-05
task_number: 9
title: Reshape api-gateway — new `modules/cart/`, rename `modules/retail/` → `modules/orders/`
depends_on: [01, 02, 03, 04, 05, 06, 07, 08]
doc_deliverable: (no new doc — cross-references existing docs 02, 03, 05, 07)
---

# Task 09 — Reshape api-gateway: cart + orders modules

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** [ADR-009](../../docs/adr/009-port-adapter-at-the-gateway.md) (the port-and-adapter split at the gateway — `ClientProxy` allowed only in `infrastructure/messaging/*-rabbitmq.adapter.ts`; controllers + pipes inject the port symbol), [ADR-010](../../docs/adr/010-jwt-rbac-at-the-gateway.md) (`@Public()` / `@Roles()` / `@CurrentUser()` decorators; new permission codes `customer:own-orders:read` and `order:capture`), [ADR-008](../../docs/adr/008-rabbitmq-via-libs-messaging.md) (routing-key constants), [ADR-017](../../docs/adr/017-architecture-lint-via-eslint-boundaries.md) (the new `cart/` element-type fixture; the cross-module ban between cart/ and orders/).

## Goal

Reshape the api-gateway to match the retail-microservice's new shape:

- Delete `apps/api-gateway/src/modules/retail/` entirely. (Task-01 left the gateway adapter in an inline-literal state with TODO markers — this task removes it.)
- Add `apps/api-gateway/src/modules/cart/` — full hexagonal layout (controller, use cases, port, RMQ adapter, DTOs, pipes).
- Add `apps/api-gateway/src/modules/orders/` — full hexagonal layout (controller, use cases, port, RMQ adapter, DTOs, pipes). The naming follows the canonical convention from ADR-009 (modules named after the downstream microservice's bounded context).
- Wire HTTP endpoints per the epic's API surface table.
- Wire the new permission codes via `@RequiresPermission('customer:own-orders:read')` (for the read paths) and `@RequiresPermission('order:capture')` (for the explicit Capture endpoint admin path).

## Entry state assumed

Tasks 01–08 carryover present:

- The retail-microservice exposes nine RPC routing keys: 5 cart (`retail.cart.create / get / line.append / line.quantity-set / line.remove`) and 4 order (`retail.order.place / capture / get / list-mine`).
- All wire DTOs (request + response) defined in `libs/contracts/retail/{cart,orders,payment}/dto/`.
- `MicroserviceClientRetailModule` (from `libs/messaging`) exposes the `ClientProxy` for outbound RPC to `retail_queue`.

## Scope

**In:**

- **Delete** `apps/api-gateway/src/modules/retail/` (the entire folder): controller, use cases, port, adapter, DTOs, pipes. The task-01 inline-literal workaround on the legacy adapter goes with it.
- **New** `apps/api-gateway/src/modules/cart/`:
  - `application/ports/cart-gateway.port.ts` — `ICartGatewayPort` with `createCart`, `getCart`, `addLine`, `changeLineQuantity`, `removeLine` methods, mapping 1:1 to the cart microservice RPCs. `CART_GATEWAY_PORT` DI symbol.
  - `application/use-cases/create-cart.use-case.ts`, `add-to-cart.use-case.ts`, `change-cart-line-quantity.use-case.ts`, `remove-cart-line.use-case.ts`, `get-cart.use-case.ts` — each is a thin pass-through to the port. The gateway-side use cases exist so the controller doesn't directly call the port (preserves ADR-009 layering — controller → use-case → port).
  - `infrastructure/messaging/cart-rabbitmq.adapter.ts` — the `ICartGatewayPort` implementation. Wraps the retail `ClientProxy` with `firstValueFrom`. **This is the only place `ClientProxy` lives** on the gateway side for cart.
  - `infrastructure/cart.module.ts` — `imports: [MicroserviceClientRetailModule], providers: [...five use cases, { provide: CART_GATEWAY_PORT, useClass: CartRabbitmqAdapter }, CartRabbitmqAdapter], controllers: [CartController]`.
  - `presentation/cart.controller.ts` — five HTTP routes:
    - `POST /api/cart` — `@Public()` (the create-cart endpoint accepts both anonymous and authenticated callers; the use case figures out which).
    - `GET /api/cart/:cartId` — `@RequiresPermission('customer:own-orders:read')` (the same permission scopes cart reads — the customer can read their own cart; the alternative of a separate `cart:read` permission is unnecessary and would clutter the policy).
    - `POST /api/cart/:cartId/lines` — `@RequiresPermission('customer:own-orders:read')`.
    - `PATCH /api/cart/:cartId/lines/:lineId` — `@RequiresPermission('customer:own-orders:read')`.
    - `DELETE /api/cart/:cartId/lines/:lineId` — `@RequiresPermission('customer:own-orders:read')`.
  - `presentation/dto/*.dto.ts` — HTTP-side request bodies with `class-validator` + `@nestjs/swagger` decorators. Each maps 1:1 to the wire DTO from `libs/contracts/retail/cart/dto/` but carries the HTTP-specific concerns (e.g. the `cartId` from a URL param, the `quantity` `@Min(1)` validator).
  - `presentation/pipes/cart-owner.pipe.ts` — a `PipeTransform` that loads the cart via the port, asserts `cart.customerId === currentUser.id` (or `customerId === null` for the guest path), throws `ForbiddenException` otherwise. Used on the cart-line endpoints.
- **New** `apps/api-gateway/src/modules/orders/`:
  - `application/ports/orders-gateway.port.ts` — `IOrdersGatewayPort` with `placeOrder`, `capturePayment`, `getOrder`, `listMyOrders`. `ORDERS_GATEWAY_PORT` DI symbol.
  - `application/use-cases/place-order.use-case.ts`, `capture-payment.use-case.ts`, `get-order.use-case.ts`, `list-my-orders.use-case.ts` — thin pass-throughs.
  - `infrastructure/messaging/orders-rabbitmq.adapter.ts` — implements the port; wraps the retail `ClientProxy`.
  - `infrastructure/orders.module.ts`.
  - `presentation/orders.controller.ts`:
    - `POST /api/cart/:cartId/place` — `@RequiresPermission('customer:own-orders:read')`. Reads the `Idempotency-Key` header via `@Headers('idempotency-key')` and forwards.
    - `GET /api/orders/:orderId` — `@RequiresPermission('customer:own-orders:read')` OR admin role with `order:read`.
    - `GET /api/orders` — `@RequiresPermission('customer:own-orders:read')`. Paginated.
    - `POST /api/orders/:orderId/payments/capture` — `@RequiresPermission('order:capture')` (admin path) OR customer-owner check at the use case (for self-service capture). Reads the `Idempotency-Key` header.
  - `presentation/dto/*.dto.ts` — HTTP request bodies + response shapes.
  - `presentation/pipes/order-owner.pipe.ts` — analogous to cart-owner.
- **Note on the `POST /api/cart/:cartId/place` placement.** The endpoint is on the cart URL space but in the orders module — the cart's "place" verb belongs to the orders bounded context (it creates an Order). The use case is `PlaceOrderUseCase` in the orders module; the controller for the endpoint lives in `apps/api-gateway/src/modules/orders/presentation/orders.controller.ts`. This crosses the URL prefix convention. ADR-009 §"modules are named after the downstream microservice, not the URL prefix" supports this choice; the controller's `@Controller()` decorator has no path prefix, and each method's `@Post('/api/cart/:cartId/place')` carries the full path explicitly.
- New permission codes registered:
  - `customer:own-orders:read` — added to the customer role seed (epic-01's permission system).
  - `order:capture` — added to admin + `order-support` roles.
  - `order:read` — already exists (epic-01); verify; if absent, add.
  - The seed extension goes in `scripts/test-db-seed.ts` — this task does the code path; task-12 ships the seed value additions.
- `app.module.ts` updates: import `CartModule` and `OrdersModule` (gateway-side); remove the deleted `RetailModule` import.
- Doc deliverable: this task does NOT own a new doc. The forward-flow is captured by docs 02 (cart) + 03 (order) + 05 (payment gateway) + 07 (authorize/capture) + 10 (HTTP files — task-10).

**Out:**

- The Kulala HTTP files — task-10.
- The seed values for permission codes — task-12 (this task references them; the seed insert is task-12).
- The notification consumer re-point — task-11.
- The architecture-lint fixture extension — task-12.

## Files to add

(Many — listed by folder for brevity.)

- `apps/api-gateway/src/modules/cart/` — complete folder:
  - `application/ports/cart-gateway.port.ts`
  - `application/ports/index.ts`
  - `application/use-cases/{create-cart,add-to-cart,change-cart-line-quantity,remove-cart-line,get-cart}.use-case.ts`
  - `application/use-cases/index.ts`
  - `infrastructure/messaging/cart-rabbitmq.adapter.ts`
  - `infrastructure/cart.module.ts`
  - `presentation/cart.controller.ts`
  - `presentation/dto/create-cart-request.dto.ts`, `add-cart-line-request.dto.ts`, `change-cart-line-quantity-request.dto.ts`, `cart-response.dto.ts`
  - `presentation/pipes/cart-owner.pipe.ts`
- `apps/api-gateway/src/modules/orders/` — complete folder, analogous structure.

## Files to modify

- `apps/api-gateway/src/app/app.module.ts` — replace `RetailModule` with `CartModule` + `OrdersModule`.

## Files to delete

- `apps/api-gateway/src/modules/retail/` — the entire folder (the task-01 inline-literal workaround inside it goes too).

## Tests

- Unit tests on the gateway-side use cases are thin (they delegate to the port). Each use case spec asserts the port is called with the right payload shape.
- The cart-owner pipe and order-owner pipe each get a spec covering the owner-check logic (matches → passes; mismatches → throws Forbidden; admin → passes regardless of ownership).
- The RMQ adapter spec asserts `ClientProxy.send` is called with the right routing-key string and the payload is forwarded.
- The HTTP routes themselves are exercised by task-12's e2e tests; this task does not add controller-level integration tests.
- `yarn lint` passes (with the boundaries rule asserting the new `cart/` module is internally consistent).
- `yarn build:api-gateway` succeeds.

## Doc deliverable

No new doc owned by this task. Cross-link the existing docs from the controller class-level JSDoc:

- `cart.controller.ts` — JSDoc summary citing `02-cart-aggregate-and-q1-q3-decisions.md` for the Q1/Q3 decisions backing the endpoint set.
- `orders.controller.ts` — JSDoc summary citing `03-order-three-status-and-q4-decision.md`, `05-payment-gateway-port-and-fake-adapter.md`, and `07-authorize-on-place-capture-explicit-q5.md` for the design rationale.

## Carryover produced (consumed by task-10 onward)

- `apps/api-gateway/src/modules/cart/` and `modules/orders/` fully wired.
- HTTP routes per the epic's API surface table working end-to-end.
- `Idempotency-Key` header captured at the controller layer and forwarded to the use case payload (not enforced — `epic-12`).
- `@RequiresPermission(...)` decorators in place for the two new permission codes.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`); the boundaries rule is happy with the new `cart/` element type at the gateway.
- [ ] `yarn test:unit` passes; the gateway-side use-case + adapter + pipe specs green.
- [ ] `yarn build:api-gateway` succeeds.
- [ ] `yarn start:dev` boots the full stack; `curl -X POST http://localhost:3000/api/cart` with no body produces a `201` + cart JSON; `curl -X POST http://localhost:3000/api/cart/<id>/place` with a body + `Idempotency-Key` header produces a `200` + order JSON with `paymentStatus='authorized'`.
- [ ] `apps/api-gateway/src/modules/retail/` does NOT exist on disk.
- [ ] `grep -rE "ClientProxy" apps/api-gateway/src` returns hits only inside `*-rabbitmq.adapter.ts` files (ADR-009 boundary preserved).
- [ ] No file outside `tmp/` references `tmp/`.
