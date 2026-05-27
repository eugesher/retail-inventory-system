---
epic: epic-05
task_number: 5
title: Implement Add to Cart / Remove from Cart / Change Quantity / Get Cart / Create Cart use cases + controllers
depends_on: [01, 02, 03, 04]
doc_deliverable: docs/implementation/epic-05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md (use-case half — completes the file)
---

# Task 05 — Implement cart use cases + controller handlers

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** [ADR-001](../../docs/adr/001-structured-logging-with-pino.md) (PinoLogger inside `@MessagePattern` handlers — always inline `correlationId`, never `.assign()`), [ADR-008](../../docs/adr/008-rabbitmq-via-libs-messaging.md) (dotted routing keys + the publisher port boundary), [ADR-011](../../docs/adr/011-notifier-port-and-adapters.md) (the per-module template + the `@MessagePattern` log shape), [ADR-013](../../docs/adr/013-order-aggregate-and-cross-service-confirm.md) (the `OrderEventsPublisherPort` pattern that this task's `CartEventsPublisherPort` mirrors).

## Goal

Land the five cart use cases against the `Cart` aggregate from task-02 + the catalog-side Select Applicable Price RPC from `epic-03`:

- `CreateCartUseCase` — creates a cart row, possibly without a `customerId` (guest path).
- `AddToCartUseCase` — appends a CartLine, snapshotting `unitPriceMinor` via `catalog.price.select-applicable` (registered by `epic-03`). Optionally calls `cart.assignCustomerId(...)` if the bearer header carries a customer id and the loaded cart had `customerId === null` (the Q1 promotion path — partial; full promotion at first login is `epic-01`'s purview).
- `RemoveCartLineUseCase` — removes a line.
- `ChangeCartLineQuantityUseCase` — mutates a line's quantity.
- `GetCartUseCase` — read-by-id, with an owner-check at the use-case layer (the controller injects the authenticated user; the use case rejects if `cart.customerId !== currentUser.id` AND `cart.customerId !== null`).

This task also lands:

- A new `CartEventsPublisherPort` + `CART_EVENTS_PUBLISHER` symbol in `application/ports/`.
- The implementation `CartRabbitmqPublisher` in `infrastructure/messaging/` — wraps `ClientProxy.emit` with `firstValueFrom` for the four new routing keys. **This is the only place `ClientProxy` is allowed at the retail-microservice side** (ADR-020).
- The four new routing-key constants in `libs/messaging/routing-keys.constants.ts` (`RETAIL_CART_CREATED`, `RETAIL_CART_LINE_ADDED`, `RETAIL_CART_LINE_REMOVED`, `RETAIL_CART_LINE_QUANTITY_CHANGED`) + matching wire-format value-for-value entries.
- The `cart.controller.ts` `@MessagePattern` handlers — five RPC handlers, one per use case.

## Entry state assumed

Tasks 02–04 carryover present:

- The `Cart` + `CartLine` domain models on disk with their specs green.
- The `cart` + `cart_line` tables in MySQL.
- `ICartRepositoryPort` + `CartTypeormRepository` wired in `CartModule`.
- The four `libs/contracts/retail/cart/events/` interfaces (task-02 shipped these).
- The catalog microservice (epic-02) exposes the variant lookup RPC; the pricing microservice (epic-03) exposes Select Applicable Price. Both have routing-key constants in `libs/messaging/routing-keys.constants.ts` (verify before this task — if absent, the prerequisite is incomplete).
- The retail microservice's `app.module.ts` imports `MicroserviceClientCatalogModule` (from `libs/messaging`) — verify; if not, this task adds the import.

## Scope

**In:**

- Five new use cases under `apps/retail-microservice/src/modules/cart/application/use-cases/`:
  - `create-cart.use-case.ts` + spec
  - `add-to-cart.use-case.ts` + spec
  - `remove-cart-line.use-case.ts` + spec
  - `change-cart-line-quantity.use-case.ts` + spec
  - `get-cart.use-case.ts` + spec
- New port `apps/retail-microservice/src/modules/cart/application/ports/cart-events-publisher.port.ts`:
  ```ts
  export const CART_EVENTS_PUBLISHER = Symbol('CART_EVENTS_PUBLISHER');
  export interface ICartEventsPublisherPort {
    emitCreated(event: ICartCreatedEvent): Promise<void>;
    emitLineAdded(event: ICartLineAddedEvent): Promise<void>;
    emitLineRemoved(event: ICartLineRemovedEvent): Promise<void>;
    emitLineQuantityChanged(event: ICartLineQuantityChangedEvent): Promise<void>;
  }
  ```
- New port `apps/retail-microservice/src/modules/cart/application/ports/catalog-pricing-gateway.port.ts`:
  ```ts
  export const CATALOG_PRICING_GATEWAY = Symbol('CATALOG_PRICING_GATEWAY');
  export interface ICatalogPricingGatewayPort {
    selectApplicablePrice(payload: {
      variantId: number;
      currency: string;
      correlationId?: string;
    }): Promise<{ unitPriceMinor: number; currency: string }>;
    fetchVariantSnapshot(payload: {
      variantId: number;
      correlationId?: string;
    }): Promise<{ sku: string; name: string; currency: string }>;
  }
  ```
  The two methods are co-located on one port because Add to Cart calls both (one to validate the variant exists + grab the currency; one to look up the price). Task-06's Place Order will call the same port for the order-line snapshots. Defining the port here lets task-06 inject the same adapter.
- New adapter `infrastructure/messaging/catalog-pricing-rabbitmq.adapter.ts` — the `ICatalogPricingGatewayPort` implementation. Wraps the catalog `ClientProxy` (from `MicroserviceClientCatalogModule`) with `firstValueFrom` + the existing `throwRpcError` helper from `apps/api-gateway/src/common/utils/throw-rpc-error.ts` (this helper is gateway-side; if it does not exist on the retail side, add an equivalent under `apps/retail-microservice/src/common/utils/`).
- New port + adapter for the publisher:
  - `infrastructure/messaging/cart-rabbitmq.publisher.ts` implements `ICartEventsPublisherPort`. Wraps the retail-microservice's own `ClientProxy` (the one bound to `notification_events` via `MicroserviceClientNotificationModule`? — verify: cart events are published to the retail-emit-side `ClientProxy`; consult `libs/messaging/microservice-client.factory.ts` for which `ClientProxy` corresponds to outbound retail emits — the standard pattern is the same `ClientProxy` instance, but the routing-key string determines the queue binding at the broker side).
- New routing-key constants in `libs/messaging/routing-keys.constants.ts`:
  - `RETAIL_CART_CREATED = 'retail.cart.created'`
  - `RETAIL_CART_LINE_ADDED = 'retail.cart.line-added'`
  - `RETAIL_CART_LINE_REMOVED = 'retail.cart.line-removed'`
  - `RETAIL_CART_LINE_QUANTITY_CHANGED = 'retail.cart.line-quantity-changed'`
- Update `routing-keys.constants.spec.ts` (the value-for-value enum agreement) + the legacy `MicroserviceMessagePatternEnum` (`libs/contracts/microservices/`) with the matching four entries.
- New presentation under `apps/retail-microservice/src/modules/cart/presentation/`:
  - `cart.controller.ts` — five `@MessagePattern` handlers, one per use case. Routing keys used here are RPC patterns (request-response), not the four event keys above. The RPC routing keys are new:
    - `RETAIL_CART_CREATE = 'retail.cart.create'` — RPC
    - `RETAIL_CART_GET = 'retail.cart.get'` — RPC
    - `RETAIL_CART_LINE_APPEND = 'retail.cart.line.append'` — RPC (add a line)
    - `RETAIL_CART_LINE_QUANTITY_SET = 'retail.cart.line.quantity-set'` — RPC
    - `RETAIL_CART_LINE_REMOVE = 'retail.cart.line.remove'` — RPC
  - These five RPC constants are ALSO new — add them to `routing-keys.constants.ts` + the enum mirror.
- New `cart.module.ts` updates:
  - `imports: [DatabaseModule.forFeature([CartEntity, CartLineEntity]), MicroserviceClientCatalogModule, MicroserviceClientNotificationModule /* or whichever outbound module the retail emits go through — verify */]`
  - `providers: [...repository, ...five use cases, { provide: CART_EVENTS_PUBLISHER, useClass: CartRabbitmqPublisher }, CartRabbitmqPublisher, { provide: CATALOG_PRICING_GATEWAY, useClass: CatalogPricingRabbitmqAdapter }, CatalogPricingRabbitmqAdapter]`
  - `controllers: [CartController]`
  - `exports: [CATALOG_PRICING_GATEWAY]` so task-06's PlaceOrderUseCase (in `modules/orders/`) can reuse it without re-binding.
- New wire-DTOs under `libs/contracts/retail/cart/dto/`:
  - `create-cart-request.dto.ts` — `{ currency?: string; customerId?: string | null }`. Currency defaults to `'USD'` server-side if omitted.
  - `add-line-request.dto.ts` — `{ variantId: number; quantity: number }`.
  - `change-line-quantity-request.dto.ts` — `{ quantity: number }`.
  - `cart-response.dto.ts` — the projection returned by Get Cart and by every mutator. Shape: `{ id, customerId, currency, status, lines: ICartLineDto[], version, updatedAt }`.
  - `cart-line.dto.ts` — `{ id, variantId, quantity, unitPriceSnapshotMinor, currencySnapshot }`.
- Doc deliverable append `02-cart-aggregate-and-q1-q3-decisions.md` — use-case-flow half (task-02 wrote the intro half).

**Out:**

- Place Order (the cart → order conversion) — task-06.
- The api-gateway-side cart controller / RMQ adapter / HTTP DTOs — task-09.
- The `http/cart.http` Kulala file — task-10.
- E2E tests of the cart-to-order flow — task-12.

## `AddToCartUseCase` shape

The most-instructive use case. The others are simpler variations.

```ts
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICartResponseDto, ICurrentUser } from '@retail-inventory-system/contracts';

import { Cart } from '../../domain';
import {
  CART_EVENTS_PUBLISHER,
  CART_REPOSITORY,
  CATALOG_PRICING_GATEWAY,
  ICartEventsPublisherPort,
  ICartRepositoryPort,
  ICatalogPricingGatewayPort,
} from '../ports';

export interface IAddToCartPayload {
  cartId: string;
  variantId: number;
  quantity: number;
  currentUser?: ICurrentUser | null; // null for guest
  correlationId?: string;
}

@Injectable()
export class AddToCartUseCase {
  constructor(
    @Inject(CART_REPOSITORY) private readonly cartRepository: ICartRepositoryPort,
    @Inject(CATALOG_PRICING_GATEWAY) private readonly catalog: ICatalogPricingGatewayPort,
    @Inject(CART_EVENTS_PUBLISHER) private readonly publisher: ICartEventsPublisherPort,
    @InjectPinoLogger(AddToCartUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IAddToCartPayload): Promise<ICartResponseDto> {
    const cart = await this.cartRepository.findById(payload.cartId);
    if (!cart) {
      throw new Error(`Cart ${payload.cartId} not found`);
    }

    // Q1 promotion path. If the bearer's customerId is set and the cart's
    // customerId is null (guest cart), assign now. Idempotent.
    if (payload.currentUser?.id && cart.customerId === null) {
      cart.assignCustomerId(payload.currentUser.id);
    }
    // If the bearer's customerId is set and does not match the cart's owner,
    // reject. (The api-gateway-side owner-check pipe (task-09) already filters
    // most of these, but defense-in-depth at the use-case layer.)
    if (payload.currentUser?.id && cart.customerId && payload.currentUser.id !== cart.customerId) {
      throw new Error('Cart belongs to another customer');
    }

    // Fetch the variant + price snapshot from the catalog/pricing side.
    const [snapshot, price] = await Promise.all([
      this.catalog.fetchVariantSnapshot({
        variantId: payload.variantId,
        correlationId: payload.correlationId,
      }),
      this.catalog.selectApplicablePrice({
        variantId: payload.variantId,
        currency: cart.currency,
        correlationId: payload.correlationId,
      }),
    ]);
    if (snapshot.currency !== cart.currency) {
      throw new Error(
        `Variant currency ${snapshot.currency} does not match cart currency ${cart.currency}`,
      );
    }

    cart.addLine({
      lineId: null,
      variantId: payload.variantId,
      quantity: payload.quantity,
      unitPriceSnapshotMinor: price.unitPriceMinor,
      currencySnapshot: cart.currency,
    });

    const saved = await this.cartRepository.save(cart);

    // Drain events post-save and fan out. Each emit is logged with
    // `correlationId` inline because we may be inside a @MessagePattern scope.
    const events = saved.pullDomainEvents();
    for (const event of events) {
      // Switch by event type. Demonstrated for one case below.
      if (event.eventName === 'cart.line-added') {
        await this.publisher.emitLineAdded({
          ...event.payload,
          eventVersion: 'v1',
          occurredAt: new Date().toISOString(),
          correlationId: payload.correlationId,
        });
      } else if (event.eventName === 'cart.created') {
        // can be present if create + add in one transaction (not the case here)
        await this.publisher.emitCreated({ ...event.payload, eventVersion: 'v1', occurredAt: new Date().toISOString(), correlationId: payload.correlationId });
      }
      // ...rest of the event types omitted
    }

    this.logger.info(
      {
        correlationId: payload.correlationId,
        cartId: saved.id,
        variantId: payload.variantId,
        quantity: payload.quantity,
        unitPriceSnapshotMinor: price.unitPriceMinor,
      },
      'Cart line added',
    );

    return this.toResponseDto(saved);
  }

  private toResponseDto(cart: Cart): ICartResponseDto {
    return {
      id: cart.id,
      customerId: cart.customerId,
      currency: cart.currency,
      status: cart.status,
      version: cart.version,
      updatedAt: cart.updatedAt.toISOString(),
      lines: cart.lines.map((l) => ({
        id: l.id!,
        variantId: l.variantId,
        quantity: l.quantity,
        unitPriceSnapshotMinor: l.unitPriceSnapshotMinor,
        currencySnapshot: l.currencySnapshot,
      })),
    };
  }
}
```

Notes:

- The use case inlines `correlationId` in every Pino log call (ADR-001 §"Binding rules for implementers"). `PinoLogger.assign()` is forbidden here — would throw outside request scope.
- Publisher failures are NOT swallowed in this use case (the legacy `OrderRabbitmqPublisher` swallowed and warn-logged `retail.order.created` failures per ADR-013; we preserve that contract on `retail.cart.line-added` because the consumer is the notification microservice — currently no cart-event consumer, but `epic-10` will subscribe — and we don't want a notification outage to fail the cart mutation). The adapter implementation logs at `warn` and swallows; the doc explains the trade-off.
- The variant + price lookups run in parallel via `Promise.all` because they are independent. The doc deliverable should note this; the spec asserts both calls happen exactly once per `execute`.
- `pullDomainEvents()` is an `AggregateRoot` method — task-02's `Cart extends AggregateRoot<string>` provides it. The post-save event drain is the standard pattern. The aggregate's recorded events do NOT contain the auto-assigned line id — the mapper's post-save rewrite step is the source of the right id at this point in the flow.

## Other use cases — shape sketches

```ts
// create-cart.use-case.ts
@Injectable()
export class CreateCartUseCase {
  constructor(
    @Inject(CART_REPOSITORY) private readonly cartRepository: ICartRepositoryPort,
    @Inject(CART_EVENTS_PUBLISHER) private readonly publisher: ICartEventsPublisherPort,
    @InjectPinoLogger(CreateCartUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: {
    currency?: string;
    currentUser?: ICurrentUser | null;
    correlationId?: string;
  }): Promise<ICartResponseDto> {
    const customerId = payload.currentUser?.id ?? null;
    const currency = payload.currency ?? 'USD';

    // Deduplicate: if the customer has an active cart, return it. (Q1 — one
    // live cart per authenticated customer at a time. Guests get a fresh
    // cart on every call; the front-end is expected to cache the cart id in
    // a cookie.)
    if (customerId) {
      const existing = await this.cartRepository.findActiveByCustomerId(customerId);
      if (existing) {
        this.logger.info(
          { correlationId: payload.correlationId, cartId: existing.id, customerId },
          'Reused existing active cart',
        );
        return this.toResponseDto(existing);
      }
    }

    const cart = Cart.create({
      id: crypto.randomUUID(),
      customerId,
      currency,
    });

    const saved = await this.cartRepository.save(cart);
    const events = saved.pullDomainEvents();
    for (const event of events) {
      if (event.eventName === 'cart.created') {
        await this.publisher.emitCreated({ ...event.payload, eventVersion: 'v1', occurredAt: new Date().toISOString(), correlationId: payload.correlationId });
      }
    }
    this.logger.info({ correlationId: payload.correlationId, cartId: saved.id, customerId }, 'Cart created');
    return this.toResponseDto(saved);
  }
  // ...toResponseDto identical to AddToCart's
}

// remove-cart-line.use-case.ts — owner-check + cart.removeLine + save + publish + log
// change-cart-line-quantity.use-case.ts — owner-check + cart.changeLineQuantity + save + publish + log
// get-cart.use-case.ts — owner-check, no save, no publish. Returns the projection.
```

## `cart.controller.ts` shape

```ts
import { Controller, Inject } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ROUTING_KEYS } from '@retail-inventory-system/messaging';
import {
  IAddToCartRequest,
  ICartResponseDto,
  IChangeLineQuantityRequest,
  ICreateCartRequest,
  IRemoveCartLineRequest,
  IGetCartRequest,
} from '@retail-inventory-system/contracts';

import {
  AddToCartUseCase,
  ChangeCartLineQuantityUseCase,
  CreateCartUseCase,
  GetCartUseCase,
  RemoveCartLineUseCase,
} from '../application/use-cases';

@Controller()
export class CartController {
  constructor(
    private readonly createCart: CreateCartUseCase,
    private readonly addToCart: AddToCartUseCase,
    private readonly removeLine: RemoveCartLineUseCase,
    private readonly changeQuantity: ChangeCartLineQuantityUseCase,
    private readonly getCart: GetCartUseCase,
    @InjectPinoLogger(CartController.name) private readonly logger: PinoLogger,
  ) {}

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_CREATE)
  public async handleCreate(@Payload() payload: ICreateCartRequest): Promise<ICartResponseDto> {
    return this.createCart.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_LINE_APPEND)
  public async handleAddLine(@Payload() payload: IAddToCartRequest): Promise<ICartResponseDto> {
    return this.addToCart.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_LINE_REMOVE)
  public async handleRemoveLine(@Payload() payload: IRemoveCartLineRequest): Promise<ICartResponseDto> {
    return this.removeLine.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_LINE_QUANTITY_SET)
  public async handleChangeQuantity(@Payload() payload: IChangeLineQuantityRequest): Promise<ICartResponseDto> {
    return this.changeQuantity.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_GET)
  public async handleGetCart(@Payload() payload: IGetCartRequest): Promise<ICartResponseDto> {
    return this.getCart.execute(payload);
  }
}
```

## Files to add

- `apps/retail-microservice/src/modules/cart/application/use-cases/create-cart.use-case.ts` + `spec/create-cart.use-case.spec.ts`
- `apps/retail-microservice/src/modules/cart/application/use-cases/add-to-cart.use-case.ts` + `spec/add-to-cart.use-case.spec.ts`
- `apps/retail-microservice/src/modules/cart/application/use-cases/remove-cart-line.use-case.ts` + `spec/remove-cart-line.use-case.spec.ts`
- `apps/retail-microservice/src/modules/cart/application/use-cases/change-cart-line-quantity.use-case.ts` + `spec/change-cart-line-quantity.use-case.spec.ts`
- `apps/retail-microservice/src/modules/cart/application/use-cases/get-cart.use-case.ts` + `spec/get-cart.use-case.spec.ts`
- `apps/retail-microservice/src/modules/cart/application/use-cases/index.ts`
- `apps/retail-microservice/src/modules/cart/application/use-cases/spec/test-doubles.ts` — in-memory `ICartRepositoryPort` + `ICatalogPricingGatewayPort` + `ICartEventsPublisherPort` doubles for the specs to share.
- `apps/retail-microservice/src/modules/cart/application/ports/cart-events-publisher.port.ts`
- `apps/retail-microservice/src/modules/cart/application/ports/catalog-pricing-gateway.port.ts`
- `apps/retail-microservice/src/modules/cart/infrastructure/messaging/cart-rabbitmq.publisher.ts` + `spec/cart-rabbitmq.publisher.spec.ts`
- `apps/retail-microservice/src/modules/cart/infrastructure/messaging/catalog-pricing-rabbitmq.adapter.ts` + `spec/catalog-pricing-rabbitmq.adapter.spec.ts`
- `apps/retail-microservice/src/modules/cart/presentation/cart.controller.ts`
- `libs/contracts/retail/cart/dto/create-cart-request.dto.ts`
- `libs/contracts/retail/cart/dto/add-line-request.dto.ts`
- `libs/contracts/retail/cart/dto/change-line-quantity-request.dto.ts`
- `libs/contracts/retail/cart/dto/remove-cart-line-request.dto.ts`
- `libs/contracts/retail/cart/dto/get-cart-request.dto.ts`
- `libs/contracts/retail/cart/dto/cart-response.dto.ts`
- `libs/contracts/retail/cart/dto/cart-line.dto.ts`
- `libs/contracts/retail/cart/dto/index.ts`

## Files to modify

- `apps/retail-microservice/src/modules/cart/application/ports/index.ts` — re-export the two new ports + symbols.
- `apps/retail-microservice/src/modules/cart/infrastructure/cart.module.ts` — imports + providers + controllers + exports per the spec above.
- `libs/messaging/routing-keys.constants.ts` — five new RPC constants + four new event constants (nine total).
- `libs/messaging/spec/routing-keys.constants.spec.ts` — extend the agreement assertions.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts` — nine matching entries.
- `libs/contracts/retail/cart/index.ts` — re-export from `dto/`.

## Tests

- `create-cart.use-case.spec.ts` — ≥5 cases: anonymous create produces a cart with `customerId=null`; authenticated create with no existing cart produces a cart with `customerId=<user.id>`; authenticated create with an active cart returns the existing cart (no insert); default currency is `'USD'`; emit-created is called exactly once.
- `add-to-cart.use-case.spec.ts` — ≥7 cases: happy path; cart not found rejects; cross-customer-owner rejects; guest cart promotes on bearer; adding same variant twice merges quantity (and emits one `line-quantity-changed` not two `line-added`); currency mismatch between cart and variant rejects; catalog RPC failure surfaces as a rejection (does NOT silently fall through).
- `remove-cart-line.use-case.spec.ts` — ≥4 cases: happy path; non-existent line rejects; cross-customer-owner rejects; emit-removed called once with the right line id.
- `change-cart-line-quantity.use-case.spec.ts` — ≥4 cases: happy path; non-existent line rejects; same-value-as-before is a no-op (no emit); negative or zero quantity rejects.
- `get-cart.use-case.spec.ts` — ≥3 cases: happy path returns the projection; cart not found rejects; cross-customer-owner rejects.
- `cart-rabbitmq.publisher.spec.ts` — ≥3 cases: the four emit methods each call `ClientProxy.emit` with the right routing-key string; the `firstValueFrom` wrapping is awaited; a publish failure logs at warn but does not throw (mirrors ADR-013 §"Publish failures on post-commit are warn-logged and swallowed").
- `catalog-pricing-rabbitmq.adapter.spec.ts` — ≥2 cases: `fetchVariantSnapshot` routes to the catalog routing key; `selectApplicablePrice` routes to the pricing routing key.
- `yarn lint` passes.
- `yarn build:retail-microservice` succeeds.

## Doc deliverable

Append to `docs/implementation/epic-05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md` the use-case-flow half. Target +80 lines. Sections:

8. **The five use cases.** One paragraph each. Cite the input shape, the output shape, and the routing key. For `AddToCartUseCase`, explain the parallel catalog + pricing RPCs and why the same-currency check at the variant lookup is mandatory.
9. **Q1 promotion path.** The `cart.assignCustomerId(...)` is called inside `AddToCartUseCase` (not at login time) because the customer's identity becomes available at the bearer token check, which happens at the api-gateway boundary on every request. Promoting at login would require touching the auth flow; promoting on first authenticated cart mutation is cleaner. The use case is idempotent — promoting twice is a no-op.
10. **Why publishers are warn-and-swallow.** Cite ADR-013's same contract. The trade-off: post-commit reliability is on the broker, not on the application. A notification outage must not block a successful cart write. Forward link to `epic-12`'s outbox pattern (deferred work) which closes the at-least-once gap.
11. **The `cart.line-added` payload's `-1` sentinel.** Restate the dance from doc 02 intro: the aggregate records the event with `lineId=-1`, the mapper rewrites it post-save, and the use case publishes with the real id. Why this is the right shape (vs the alternative of "publish from the repository"). Forward link to ADR-013 §"OrderCreated is constructed after repository round-trip".
12. **Forward links.** Task-06 (Place Order — also consumes `CATALOG_PRICING_GATEWAY`); task-12 (the e2e tests that exercise the full flow); task-09 (the api-gateway-side cart module).

## Carryover produced (consumed by task-06 onward)

- Five cart use cases on disk, fully implemented + spec-covered.
- `CART_EVENTS_PUBLISHER` + `CartRabbitmqPublisher` wired.
- `CATALOG_PRICING_GATEWAY` + `CatalogPricingRabbitmqAdapter` wired and exported from `cart.module.ts` for task-06's `PlaceOrderUseCase` to reuse.
- Nine new routing-key constants (five RPC + four event).
- `cart.controller.ts` with five `@MessagePattern` handlers.
- `02-cart-aggregate-and-q1-q3-decisions.md` use-case-flow half appended.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the five use-case specs (≥23 cases total) green, plus the two adapter specs.
- [ ] `yarn build:retail-microservice` succeeds.
- [ ] `yarn start:dev:retail-microservice` boots; a `rabbitmqadmin publish` against `retail.cart.create` produces a `ICartResponseDto` reply with a UUID `id`.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] The use-case-flow half of `02-cart-aggregate-and-q1-q3-decisions.md` appended with sections 8–12.
