---
epic: epic-05
task_number: 6
title: Implement Place Order use case + authorize-on-place payment flow
depends_on: [01, 02, 03, 04, 05]
doc_deliverable: docs/implementation/epic-05-cart-order-payment-walking-skeleton/04-order-line-snapshot-and-cross-service-lookup.md + 07-authorize-on-place-capture-explicit-q5.md (authorize half) + 08-idempotency-key-header-q10.md (place half) + 09-routing-keys-retired-and-added.md (partial)
---

# Task 06 — Implement Place Order use case

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** [ADR-013](../../docs/adr/013-order-aggregate-and-cross-service-confirm.md) (the previous Place Order — note the cross-service confirm step that we no longer do; the new flow is authorize-on-place via `PAYMENT_GATEWAY`), [ADR-020](../../docs/adr/020-rabbitmq-as-inter-service-bus.md) (the publisher port boundary; the post-commit emit + warn-and-swallow contract), [ADR-001](../../docs/adr/001-structured-logging-with-pino.md) (PinoLogger inside `@MessagePattern` — inline `correlationId`), [ADR-019](../../docs/adr/019-typeorm-and-mysql-for-persistence.md) (`ITransactionPort` for the cart→order conversion transaction).

## Goal

`PlaceOrderUseCase` is the central walking-skeleton operation. It:

1. Loads the cart by id (read-only) + does owner-check at the use-case layer.
2. Validates the cart is non-empty + `status='active'`.
3. For each cart line: fetches the variant snapshot (`sku`, `name`) and the applicable price (`unitPriceMinor`, `taxAmountMinor` — see §"Tax for the walking skeleton" below) from the catalog/pricing side via `CATALOG_PRICING_GATEWAY` (exported by task-05's `CartModule`).
4. Constructs the `OrderLine[]` snapshot array.
5. Persists the billing + shipping `Address` rows (snapshots — task-03's `Address.create(...)`).
6. Constructs the `Order` aggregate via `Order.place(...)`.
7. Saves the Order; the repository returns the DB-assigned id.
8. Calls `order.markPlaced()` — records `OrderPlacedEvent` with the now-known id.
9. Calls `PAYMENT_GATEWAY.authorize(...)` with the order number + grand total.
10. On gateway success: constructs the `Payment` aggregate via `Payment.authorize(...)`, saves it, calls `order.markPaymentAuthorized()`, re-saves the order.
11. On gateway failure: calls `order.markPaymentFailed()`, re-saves the order. (Future epics may decide to abort the order at this point; for this epic, the failed-payment order survives so the customer can retry via Capture.)
12. Flips the cart to `status='converted'` and saves it.
13. Post-commit: drains `order.pullDomainEvents()` → emits `retail.order.placed` via `ORDER_EVENTS_PUBLISHER`; emits `retail.payment.authorized` (or `retail.payment.failed` — reserve that key in this task even if no consumer exists) via the same publisher.
14. Returns the response DTO (`Order` + lines + the Payment summary).

The transaction boundary covers steps 5–12 (the Address inserts + Order insert + Order re-save with `paymentStatus=authorized` + cart conversion + Payment insert). Steps 1–3 are pre-tx reads. Steps 13–14 are post-commit (so a broker outage does not roll back the order).

Open Question Q10 (the `Idempotency-Key` header) is accepted on the request payload here but NOT enforced — the use case logs the key and forwards it through to the gateway call (so the gateway adapter can use it for its own idempotency, which the fake adapter ignores). Real dedupe is `epic-12`. The doc explicitly cites this.

The use case also lands the cluster-side retirement of `retail.order.created` and `retail.order.confirmed`:

- The new `retail.order.placed` routing-key constant lands here.
- The old `retail.order.created` constant is **removed** from `libs/messaging/routing-keys.constants.ts` (task-11 re-points the consumer; the constant removal here is safe because the only producer was the deleted legacy publisher, deleted in task-01).
- `retail.order.confirmed` is **removed** (no consumer ever existed; ADR-013's port surface was reserved-for-future).
- `retail.order.cancelled` is **removed** (no producer, no consumer; `epic-09` will reintroduce a new constant if needed).

## Entry state assumed

Task-05 carryover present:

- The five cart use cases work end-to-end at the RPC layer.
- `CATALOG_PRICING_GATEWAY` + `CatalogPricingRabbitmqAdapter` exist; `CartModule` exports them.
- The four new event-side routing-key constants (`RETAIL_CART_*`) are registered.

Task-04 carryover present:

- `Payment` + `PAYMENT_GATEWAY` + `FakePaymentGatewayAdapter` wired.
- `Order.markPaymentAuthorized()` / `markPaymentCaptured()` / `markPaymentFailed()` available.

Task-03 carryover present:

- `Order.place(...)`, `Order.markPlaced()`, `OrderTypeormRepository.save` + `findById` + `findByOrderNumber` available.
- `AddressTypeormRepository.save` available.

Task-01 carryover present:

- The legacy `retail.order.{create,confirm,get}` RPC constants are gone.
- The three legacy event constants (`RETAIL_ORDER_CREATED`, `RETAIL_ORDER_CONFIRMED`, `RETAIL_ORDER_CANCELLED`) survive; this task removes them.

## Scope

**In:**

- New use case `apps/retail-microservice/src/modules/orders/application/use-cases/place-order.use-case.ts` + `spec/place-order.use-case.spec.ts`.
- New port `apps/retail-microservice/src/modules/orders/application/ports/order-events-publisher.port.ts`:
  ```ts
  export const ORDER_EVENTS_PUBLISHER = Symbol('ORDER_EVENTS_PUBLISHER');
  export interface IOrderEventsPublisherPort {
    emitPlaced(event: IOrderPlacedEvent): Promise<void>;
    emitPaymentAuthorized(event: IPaymentAuthorizedEvent): Promise<void>;
    emitPaymentCaptured(event: IPaymentCapturedEvent): Promise<void>;
    // emitPaymentFailed / emitOrderCancelled — reserved; future epics.
  }
  ```
- New adapter `apps/retail-microservice/src/modules/orders/infrastructure/messaging/order-rabbitmq.publisher.ts` (the file was deleted in task-01; this is a fresh file with a different shape) + spec.
- Cart → Order conversion is transactional via `ITransactionPort` (from `@retail-inventory-system/database` — verify the export; if not available, the project's transaction abstraction is `EntityManager.transaction()` per ADR-017 §6's now-closed exception; ADR-017 says the closed exception means `ITransactionPort` IS the abstraction now — so verify it's exported and use it). The use case wraps steps 5–12 in `transactionPort.runInTransaction(...)`. The repository methods accept the scope.
  - Verify: does `ICartRepositoryPort.save(cart, scope?)` exist on the task-02 contract? If not, extend it now to accept an optional `ITransactionScope`. Same for `IOrderRepositoryPort.save`, `IPaymentRepositoryPort.save`, `IAddressRepositoryPort.save`. The transactional repository methods do the downcast inside `infrastructure/persistence/` (ADR-017 §6).
- New presentation handler `apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts` (currently the empty-shell from task-01): a `@MessagePattern(ROUTING_KEYS.RETAIL_ORDER_PLACE)` handler that delegates to `PlaceOrderUseCase`. Task-07 adds the capture handler; task-08 adds the get + list handlers.
- New routing-key constants in `libs/messaging/routing-keys.constants.ts`:
  - `RETAIL_ORDER_PLACE = 'retail.order.place'` — RPC (the new replacement for `retail.order.create`)
  - `RETAIL_ORDER_PLACED = 'retail.order.placed'` — event (replaces `retail.order.created`)
  - `RETAIL_PAYMENT_AUTHORIZED = 'retail.payment.authorized'` — event
- **Remove** the three retired event constants: `RETAIL_ORDER_CREATED`, `RETAIL_ORDER_CONFIRMED`, `RETAIL_ORDER_CANCELLED`. Verify they have no remaining consumers:
  - `apps/notification-microservice/.../infrastructure/consumers/order-events.consumer.ts` subscribes to `retail.order.created` and is re-pointed in task-11. **This task removes the constant** — the consumer file then references the literal `'retail.order.created'` for the duration of the task-06 → task-11 window. Task-11 deletes the literal alongside the consumer re-point.
- Update the `MicroserviceMessagePatternEnum` mirror.
- Update `routing-keys.constants.spec.ts`.
- Update `orders.module.ts`:
  - Provider list adds `PlaceOrderUseCase`.
  - Provider list adds `{ provide: ORDER_EVENTS_PUBLISHER, useClass: OrderRabbitmqPublisher }, OrderRabbitmqPublisher`.
  - Imports include the `MicroserviceClientNotificationModule` (or whichever outbound `ClientProxy` module the retail-emit side uses — verify against the task-01 deletion notes).
- New wire DTOs:
  - `libs/contracts/retail/orders/dto/place-order-request.dto.ts` — fills the file task-03 ship as a placeholder.
    ```ts
    export interface IPlaceOrderRequest {
      cartId: string;
      currency: string;
      shippingAddress: IAddressInput;
      billingAddress: IAddressInput;
      paymentMethod?: { token: string }; // opaque — the fake gateway ignores it
      idempotencyKey?: string;
      currentUser?: ICurrentUser; // forwarded by the api-gateway pipe
      correlationId?: string;
    }
    export interface IAddressInput { /* …recipientName, line1, line2?, city, region, postalCode, country, phone */ }
    ```
  - `libs/contracts/retail/orders/dto/order-response.dto.ts` — fills the placeholder. Shape: `{ id, orderNumber, customerId, currency, status, paymentStatus, fulfillmentStatus, subtotalMinor, taxTotalMinor, grandTotalMinor, placedAt, lines: IOrderLineDto[], payment: IPaymentSummaryDto, shippingAddress: IAddressDto, billingAddress: IAddressDto }`.
  - `libs/contracts/retail/orders/dto/order-line.dto.ts` — `{ id, variantId, sku, nameSnapshot, quantity, unitPriceMinor, taxAmountMinor, lineTotalMinor, status }`.
  - `libs/contracts/retail/orders/dto/address.dto.ts` — the read-side projection of `Address`.
  - `libs/contracts/retail/payment/dto/payment-summary.dto.ts` — was reserved by task-04; this task fills it: `{ id, status, amountMinor, currency, method, gatewayReference, authorizedAt, capturedAt: string | null }`.
- New `libs/contracts/retail/orders/events/index.ts` re-exports the new event interface (task-03 shipped the type; this task uses it).
- Doc deliverables — see §"Doc deliverables" below.

**Out:**

- The api-gateway-side `POST /api/cart/:cartId/place` endpoint + the http-side DTO mapping — task-09.
- The Kulala http/order.http rewrite — task-10.
- The notification consumer re-point — task-11.
- The Capture Payment use case — task-07.
- The Get Order / List My Orders use cases — task-08.
- Real Idempotency-Key dedupe — `epic-12`.
- `OrderLine.taxAmountMinor` derivation against a real tax engine — `epic-15`. This epic ships `taxAmountMinor=0` per line by default; if the pricing RPC returns a tax component, the use case uses it (forward-compatible to a future tax-component-on-pricing change).

## Tax for the walking skeleton

The pricing microservice's Select Applicable Price RPC (epic-03) returns `{ unitPriceMinor, currency }` today. There is no tax component. This task **does not** invoke a tax engine. `OrderLine.taxAmountMinor` is `0` for every line. The `Order.taxTotalMinor` is therefore `0`. The doc deliverable explicitly says so; `epic-15`'s "Tax computation" exclusion is the forward link.

The aggregate already accepts a `taxAmountMinor` per line (task-03); the field is `0` today and the math `grandTotal = subtotal + tax + shipping − discount` collapses to `grandTotal = subtotal`. The future tax addition is then purely additive (no schema change, no aggregate change).

## `PlaceOrderUseCase` shape

```ts
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

import { ITransactionPort, TRANSACTION_PORT } from '@retail-inventory-system/database';
import {
  IOrderResponseDto,
  IPlaceOrderRequest,
} from '@retail-inventory-system/contracts';

import {
  Address,
  AddressOwnerTypeEnum,
  Order,
  OrderLine,
  Payment,
} from '../../domain';
import {
  ADDRESS_REPOSITORY,
  CATALOG_PRICING_GATEWAY,
  IAddressRepositoryPort,
  ICatalogPricingGatewayPort,
  IOrderRepositoryPort,
  IPaymentGatewayPort,
  IPaymentRepositoryPort,
  IOrderEventsPublisherPort,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
  PAYMENT_GATEWAY,
  PAYMENT_REPOSITORY,
} from '../ports';
import { CART_REPOSITORY, ICartRepositoryPort } from '../../../cart/application/ports';

@Injectable()
export class PlaceOrderUseCase {
  constructor(
    @Inject(CART_REPOSITORY) private readonly carts: ICartRepositoryPort,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepositoryPort,
    @Inject(ADDRESS_REPOSITORY) private readonly addresses: IAddressRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly paymentGateway: IPaymentGatewayPort,
    @Inject(CATALOG_PRICING_GATEWAY) private readonly catalog: ICatalogPricingGatewayPort,
    @Inject(ORDER_EVENTS_PUBLISHER) private readonly publisher: IOrderEventsPublisherPort,
    @Inject(TRANSACTION_PORT) private readonly tx: ITransactionPort,
    @InjectPinoLogger(PlaceOrderUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IPlaceOrderRequest): Promise<IOrderResponseDto> {
    if (payload.idempotencyKey) {
      // Q10 — accepted, not enforced. Logged for future epic-12 dedupe wiring.
      this.logger.info(
        { correlationId: payload.correlationId, cartId: payload.cartId, idempotencyKey: payload.idempotencyKey },
        'Idempotency-Key received (not yet enforced — see epic-12)',
      );
    }

    // Pre-tx reads.
    const cart = await this.carts.findById(payload.cartId);
    if (!cart) throw new Error(`Cart ${payload.cartId} not found`);
    if (cart.status !== 'active') throw new Error(`Cannot place a ${cart.status} cart`);
    if (cart.lines.length === 0) throw new Error('Cannot place an empty cart');
    if (payload.currentUser && cart.customerId && cart.customerId !== payload.currentUser.id) {
      throw new Error('Cart belongs to another customer');
    }
    if (cart.currency !== payload.currency) {
      throw new Error(`Currency mismatch: cart=${cart.currency}, request=${payload.currency}`);
    }
    const customerId = cart.customerId ?? payload.currentUser?.id;
    if (!customerId) {
      // Guest checkout — Q7 says every order produces a Customer row including guests.
      // The walking skeleton today does not yet create the guest customer here;
      // epic-01's customer registration is the canonical path. Reject for now
      // and document — the Q7 wiring lands when epic-01 ships the guest-customer
      // promotion API. The doc deliverable cites this.
      throw new Error('Guest checkout requires a guest customer row (epic-01 follow-up)');
    }

    // Snapshot lookups per cart line. Run in parallel — independent.
    const lineSnapshots = await Promise.all(
      cart.lines.map(async (l) => {
        const [variant, price] = await Promise.all([
          this.catalog.fetchVariantSnapshot({ variantId: l.variantId, correlationId: payload.correlationId }),
          this.catalog.selectApplicablePrice({ variantId: l.variantId, currency: cart.currency, correlationId: payload.correlationId }),
        ]);
        if (variant.currency !== cart.currency || price.currency !== cart.currency) {
          throw new Error(`Variant ${l.variantId} currency does not match cart currency`);
        }
        return OrderLine.create({
          variantId: l.variantId,
          sku: variant.sku,
          nameSnapshot: variant.name,
          quantity: l.quantity,
          unitPriceMinor: price.unitPriceMinor,
          taxAmountMinor: 0, // see §"Tax for the walking skeleton"
          currencySnapshot: cart.currency,
        });
      }),
    );

    // The cross-service catalog round-trip happens before the transaction.
    // Inside the transaction we only touch our own DB.
    const orderNumber = this.allocateOrderNumber();
    const { order, payment, billingAddress, shippingAddress } = await this.tx.runInTransaction(
      async (scope) => {
        // Persist addresses first (their ids are FKs on the order).
        const billing = Address.create({
          id: randomUUID(),
          ownerType: AddressOwnerTypeEnum.Order,
          ownerId: 'pending', // rewritten after order is saved with its real id
          ...payload.billingAddress,
        });
        const shipping = Address.create({
          id: randomUUID(),
          ownerType: AddressOwnerTypeEnum.Order,
          ownerId: 'pending',
          ...payload.shippingAddress,
        });
        const savedBilling = await this.addresses.save(billing, scope);
        const savedShipping = await this.addresses.save(shipping, scope);

        // Build + persist the Order.
        const built = Order.place({
          orderNumber,
          customerId,
          currency: cart.currency,
          billingAddressId: savedBilling.id,
          shippingAddressId: savedShipping.id,
          lines: lineSnapshots,
        });
        const savedOrder = await this.orders.save(built, scope);
        savedOrder.markPlaced();

        // Rewrite the owner_id on the addresses now that the order has an id.
        // (See §"Address ownerId rewrite" below for why this is a UPDATE in
        // the same transaction.)
        await this.addresses.assignOwner(savedBilling.id, { ownerType: AddressOwnerTypeEnum.Order, ownerId: String(savedOrder.id) }, scope);
        await this.addresses.assignOwner(savedShipping.id, { ownerType: AddressOwnerTypeEnum.Order, ownerId: String(savedOrder.id) }, scope);

        // Call the gateway. NOT inside the tx — the gateway is external.
        // Actually, the gateway IS called inside the transaction in this
        // shape — see §"Gateway-inside-tx tradeoff" below for the
        // implementer's decision tree.
        const gatewayResult = await this.paymentGateway.authorize({
          orderNumber: savedOrder.orderNumber,
          amountMinor: savedOrder.grandTotalMinor,
          currency: savedOrder.currency,
          methodToken: payload.paymentMethod?.token,
          idempotencyKey: payload.idempotencyKey,
          correlationId: payload.correlationId,
        });
        let paymentRow: Payment;
        if (gatewayResult.status === 'authorized') {
          const p = Payment.authorize({
            orderId: savedOrder.id!,
            amountMinor: savedOrder.grandTotalMinor,
            currency: savedOrder.currency,
            method: gatewayResult.method,
            gatewayReference: gatewayResult.gatewayReference,
          });
          paymentRow = await this.payments.save(p, scope);
          savedOrder.markPaymentAuthorized();
        } else {
          // Mark failed; persist; the order survives in failed state.
          savedOrder.markPaymentFailed();
          throw new Error(`Payment gateway returned non-success: ${gatewayResult.status}`);
        }

        // Re-save the order with the bumped paymentStatus.
        const finalOrder = await this.orders.save(savedOrder, scope);

        // Flip the cart.
        cart.markConverted();
        await this.carts.save(cart, scope);

        return {
          order: finalOrder,
          payment: paymentRow,
          billingAddress: savedBilling,
          shippingAddress: savedShipping,
        };
      },
    );

    // Post-commit: drain events and publish.
    const events = order.pullDomainEvents();
    for (const event of events) {
      if (event.eventName === 'order.placed') {
        await this.publisher.emitPlaced({
          orderId: order.id!,
          orderNumber: order.orderNumber,
          customerId: order.customerId,
          grandTotalMinor: order.grandTotalMinor,
          currency: order.currency,
          lineCount: order.lines.length,
          eventVersion: 'v1',
          occurredAt: new Date().toISOString(),
          correlationId: payload.correlationId,
        });
      }
    }
    await this.publisher.emitPaymentAuthorized({
      orderId: order.id!,
      paymentId: payment.id!,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      eventVersion: 'v1',
      occurredAt: new Date().toISOString(),
      correlationId: payload.correlationId,
    });

    this.logger.info(
      {
        correlationId: payload.correlationId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        grandTotalMinor: order.grandTotalMinor,
        paymentReference: payment.gatewayReference,
      },
      'Order placed and payment authorized',
    );

    return this.toResponseDto(order, payment, billingAddress, shippingAddress);
  }

  private allocateOrderNumber(): string {
    // Format: ORD-<YYYY>-<8-digit-sequence>. The sequence is allocated by a
    // dedicated `order_number_sequence` table or by reading the row count;
    // for the walking skeleton, derive from a unix-ms suffix to guarantee
    // uniqueness without a sequence table. The doc deliverable cites this
    // as a known-coarse approach to be replaced in epic-12.
    const year = new Date().getUTCFullYear();
    const sequence = String(Date.now()).slice(-8);
    return `ORD-${year}-${sequence}`;
  }

  // ...toResponseDto omitted.
}
```

## Address ownerId rewrite

The two address rows are inserted with `ownerId='pending'` because the order's id is not known until the order row is inserted. The repository method `assignOwner(addressId, { ownerType, ownerId }, scope)` does a single-row UPDATE inside the transaction. The doc explains why this is the chosen path:

- The alternative is to insert the order with `NULL` foreign-key columns and update them post-address-insert. That requires the `billing_address_id` and `shipping_address_id` to be `NULL`-able, which would mask data-integrity bugs at the FK level.
- The chosen path (`ownerId='pending'` then UPDATE) trades a known-and-controlled UPDATE for a guaranteed-NOT-NULL FK column, which catches more bugs.
- A future enhancement is to assign UUIDs to orders too (matching cart's CHAR(36) PK), then the order's id is known pre-insert and no rewrite is needed. That is a bigger schema decision deferred to a later epic.

## Gateway-inside-tx tradeoff

Calling `PAYMENT_GATEWAY.authorize(...)` inside the database transaction is the chosen path for this epic because the fake adapter is in-process and zero-latency. With a real gateway (Stripe / PayPal), holding a DB transaction open for the duration of an HTTP round-trip is bad — that's a classic anti-pattern. The doc deliverable names this trade-off explicitly:

- **Today** (fake adapter): in-transaction is fine.
- **`epic-15`** (real adapter): the use case should be reshaped to "begin tx → save order with paymentStatus=none → commit → call gateway → begin tx → save payment + update order paymentStatus → commit". The two-transaction shape leaves a tiny window where the order exists but the payment is uncalled; the recovery is a periodic re-poll of "Pending payment authorize" orders. The doc explicitly says: the current single-transaction shape is right for `FakePaymentGatewayAdapter` because no real network call happens; the real-adapter introduction must reshape the use case.

## Files to add

- `apps/retail-microservice/src/modules/orders/application/use-cases/place-order.use-case.ts` + `spec/place-order.use-case.spec.ts`
- `apps/retail-microservice/src/modules/orders/application/use-cases/index.ts` (the file may already exist — add the export)
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/test-doubles.ts` — in-memory doubles for the seven ports the use case consumes.
- `apps/retail-microservice/src/modules/orders/application/ports/order-events-publisher.port.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/messaging/order-rabbitmq.publisher.ts` + `spec/order-rabbitmq.publisher.spec.ts`
- `libs/contracts/retail/orders/dto/place-order-request.dto.ts` (fills the task-03 placeholder)
- `libs/contracts/retail/orders/dto/order-response.dto.ts` (fills the placeholder)
- `libs/contracts/retail/orders/dto/order-line.dto.ts`
- `libs/contracts/retail/orders/dto/address.dto.ts`
- `libs/contracts/retail/payment/dto/payment-summary.dto.ts` (fills the task-04 placeholder)
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/04-order-line-snapshot-and-cross-service-lookup.md`
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/07-authorize-on-place-capture-explicit-q5.md` (authorize half — task-07 writes the capture half)
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/08-idempotency-key-header-q10.md` (place half — task-07 writes the capture half; task-12 final-passes)
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/09-routing-keys-retired-and-added.md` (table half — task-11 writes the consumer-side half)

## Files to modify

- `apps/retail-microservice/src/modules/orders/application/ports/index.ts` — re-export `ORDER_EVENTS_PUBLISHER`, the publisher interface.
- `apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts` — providers: PlaceOrderUseCase, OrderRabbitmqPublisher binding; imports: the outbound `ClientProxy` module; controllers: `OrdersController` if newly populated; transactional repository methods (refactor signatures to accept an optional `ITransactionScope`).
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-typeorm.repository.ts` — `save(order, scope?)` accepts the optional scope.
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/address-typeorm.repository.ts` — `save(address, scope?)` accepts the optional scope; new `assignOwner(...)` method.
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/payment-typeorm.repository.ts` — `save(payment, scope?)` accepts the optional scope.
- `apps/retail-microservice/src/modules/cart/infrastructure/persistence/cart-typeorm.repository.ts` — `save(cart, scope?)` accepts the optional scope.
- `apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts` — extend `save` signature with the optional scope.
- (Same for the three other repository ports.)
- `apps/retail-microservice/src/modules/orders/application/ports/address.repository.port.ts` — add `assignOwner(...)` method.
- `apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts` — handler for `RETAIL_ORDER_PLACE`.
- `libs/messaging/routing-keys.constants.ts` — add `RETAIL_ORDER_PLACE`, `RETAIL_ORDER_PLACED`, `RETAIL_PAYMENT_AUTHORIZED`; **remove** `RETAIL_ORDER_CREATED`, `RETAIL_ORDER_CONFIRMED`, `RETAIL_ORDER_CANCELLED`.
- `libs/messaging/spec/routing-keys.constants.spec.ts` — update the agreement assertions.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts` — add the three new entries, remove the three retired ones.
- `apps/notification-microservice/src/modules/notifications/infrastructure/consumers/order-events.consumer.ts` — replace the deleted `ROUTING_KEYS.RETAIL_ORDER_CREATED` import with the literal `'retail.order.created'` + a TODO citing task-11. (Task-11 owns the actual re-point; this task's removal of the constant forces the temporary measure.)
- `libs/contracts/retail/orders/index.ts` — re-export from `dto/`.
- `libs/contracts/retail/payment/dto/index.ts` — barrel.

## Tests

- `place-order.use-case.spec.ts` — ≥10 cases:
  1. Happy path: 2-line cart converts to an order with 2 OrderLines, snapshot fields populated, Payment row in authorized, cart status flipped to converted, three emits fire (`order.placed`, `payment.authorized`, plus `cart.line-quantity-changed`? — verify whether the cart conversion emits anything; per task-02's `markConverted()` it does not).
  2. Empty cart rejects.
  3. Cart already converted rejects.
  4. Currency mismatch (request vs cart) rejects.
  5. Cross-customer-owner rejects.
  6. Guest checkout (no current user, no cart customerId) rejects (Q7 follow-up).
  7. Catalog variant lookup failure surfaces (does not silently swallow).
  8. Gateway returns non-`authorized` → order persisted with `paymentStatus=failed` (or — per the chosen path — the use case rejects; the spec asserts whichever path the implementer chose, and the doc explains).
  9. The transaction rolls back the address+order inserts if the cart save fails.
  10. `Idempotency-Key` header is logged but does NOT change behavior (calling place twice with the same key produces two distinct orders; the spec asserts).
  11. `order.placed` event payload carries the right `lineCount`, `grandTotalMinor`, `orderNumber`.
- `order-rabbitmq.publisher.spec.ts` — ≥3 cases for the three emit methods (placed / payment-authorized / payment-captured wired in task-07).
- `yarn lint` passes.
- `yarn build:retail-microservice` succeeds.

## Doc deliverables

### `04-order-line-snapshot-and-cross-service-lookup.md` (entire file — target ~120 lines)

Sections:

1. **The snapshot is the contract.** Why `OrderLine.sku` / `nameSnapshot` / `unitPriceMinor` are immutable: the customer's order receipt must reflect what they saw when they placed; catalog edits (rename, price change, SKU rotation) cannot retroactively rewrite history. The legal/audit obligation makes this a hard requirement.
2. **Cross-service lookup at write time.** `CATALOG_PRICING_GATEWAY.fetchVariantSnapshot(...)` for `sku` + `nameSnapshot`; `CATALOG_PRICING_GATEWAY.selectApplicablePrice(...)` for `unitPriceMinor`. Both calls are RPC. The two are issued in parallel via `Promise.all` per line. The use case runs `Promise.all` across lines too — so a 5-line cart issues 10 RPCs in parallel. Forward link to `epic-12` for the batched lookup optimization (one RPC per service per place-order).
3. **Tax for the walking skeleton.** `taxAmountMinor=0` per line; pricing RPC does not return a tax component today; the future tax engine is `epic-15`'s "Tax computation" exclusion. The aggregate already accepts the field so the future addition is purely additive.
4. **The catalog port lives in `cart/application/ports/`.** Task-05 ships the port at the cart side because `AddToCartUseCase` was the first consumer; task-06 reuses it from `modules/orders/`. The cross-module port reuse is unusual — the alternative is to redefine the port in `modules/orders/`, but that duplicates the interface. The chosen path keeps one port; ADR-004 §"Cross-module imports go through `@retail-inventory-system/<lib>` contracts, never deep paths into another module" is upheld because the port file is consumed via the cart module's `exports`. Cite the alternative.
5. **The `ownerId='pending'` then UPDATE dance.** As described above — and forward link to the future UUID-PK-on-orders enhancement.
6. **Forward links.** Task-07 (capture); task-08 (read); `epic-12` (Idempotency-Key dedupe, OCC enforcement); `epic-15` (tax engine, real payment gateway).

### `07-authorize-on-place-capture-explicit-q5.md` — authorize half (target ~60 lines now; task-07 adds capture half)

Sections (this task writes 1, 2, 3; task-07 adds 4, 5):

1. **Q5 — authorize on placement is the default policy.** Restate. The customer's authorization is recorded at Place time; the merchant's capture happens later (when the warehouse ships, in `epic-08`). This epic ships authorize (auto, inline with Place Order — see this task) and capture (explicit, see task-07).
2. **Why authorize-inline-with-place.** Cite the gateway-inside-tx tradeoff. The fake adapter is zero-latency; the real adapter will require the two-transaction reshape (forward link to `epic-15`).
3. **The `PAYMENT_GATEWAY.authorize` contract.** What it returns; how the gateway's `gatewayReference` becomes the unique identifier in the `payment` table.

(Task-07 writes 4 and 5 — the capture explicit policy and the future ship-triggered automatic capture.)

### `08-idempotency-key-header-q10.md` — place half (target ~50 lines now)

Sections (this task writes 1, 2; task-07 adds 3; task-12 final-passes):

1. **Q10 — Idempotency-Key is required on Place Order and Capture Payment from day one.** Restate. The header is accepted by both endpoints. The header is forwarded to the payment gateway (which uses it for its own idempotency — the fake adapter ignores it; a real Stripe adapter would pass it as `Idempotency-Key:` to the API call).
2. **Why dedupe enforcement is deferred to `epic-12`.** The `idempotency_key` table (`epic-12`) is the canonical store for "we already saw this key with this body — return the same response". Today, calling Place Order twice with the same key produces two distinct orders. The spec asserts this is the case so the future regression test (when `epic-12` enforces dedupe) is straightforward.

(Task-07 writes 3 — the same shape for Capture Payment.)

### `09-routing-keys-retired-and-added.md` — table half (target ~80 lines now; task-11 completes)

Sections (this task writes 1, 2; task-11 adds 3):

1. **Retired routing keys.** Table: `retail.order.create`, `retail.order.confirm`, `retail.order.get`, `retail.order.created`, `retail.order.confirmed`, `retail.order.cancelled`. For each: which task removed it; what the new replacement is; whether a consumer ever existed.
2. **Added routing keys.** Table: 5 cart RPC keys + 4 cart event keys (task-05) + 3 order keys (`retail.order.place` RPC + `retail.order.placed` event + `retail.payment.authorized` event — this task) + 2 payment keys (`retail.order.capture` RPC + `retail.payment.captured` event — task-07). Total: 14 new constants across the epic.

(Task-11 writes 3 — the notification consumer's subscriber change.)

## Carryover produced (consumed by task-07 onward)

- `PlaceOrderUseCase` on disk + spec green.
- `ORDER_EVENTS_PUBLISHER` + `OrderRabbitmqPublisher` wired.
- New routing-key constants (`RETAIL_ORDER_PLACE`, `RETAIL_ORDER_PLACED`, `RETAIL_PAYMENT_AUTHORIZED`).
- Three retired event constants removed; the notification consumer references the literal until task-11.
- Place-side DTOs filled in `libs/contracts/retail/orders/dto/`.
- `OrdersController` has one handler (`RETAIL_ORDER_PLACE`); task-07 + task-08 add the others.
- Docs 04 + 07 (authorize half) + 08 (place half) + 09 (table half).
- Transactional repository signatures (the four save methods accept an optional `ITransactionScope`).

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the place-order spec (≥10 cases) green; the publisher spec green.
- [ ] `yarn build:retail-microservice` succeeds.
- [ ] `yarn start:dev:retail-microservice` boots; a `rabbitmqadmin publish` against `retail.order.place` with a seeded cart id returns an `IOrderResponseDto` with `paymentStatus='authorized'` and `gatewayReference` matching the deterministic-fake formula.
- [ ] RabbitMQ shows `retail.order.placed` + `retail.payment.authorized` events published after the call.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Docs 04 (complete), 07 (authorize half), 08 (place half), 09 (table half) exist.
