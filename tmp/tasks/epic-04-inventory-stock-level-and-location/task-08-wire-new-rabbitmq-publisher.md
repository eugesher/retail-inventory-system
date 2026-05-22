---
epic: epic-04
task_number: 8
title: Wire the new RabbitMQ publisher — three new routing keys + cleanup of legacy ones
depends_on: [01, 02, 03, 04, 05, 06, 07]
doc_deliverable: appended to docs/implementation/epic-04-inventory-stock-level-and-location/06-receive-and-adjust-use-cases.md and 05-auto-init-on-variant-created.md
---

# Task 08 — Wire the new RMQ publisher

## Goal

Consolidate the inventory microservice's emit-side wiring around a single `StockRabbitmqPublisher` class that emits all four `inventory.*` events the epic introduces or preserves: `stock.received`, `stock.adjusted`, `stock-level.initialized` (the three new ones), and `stock.low` (the pre-existing one — payload reshaped to be `variantId`-keyed, target consumer unchanged). The three new routing keys are registered in `libs/messaging/routing-keys.constants.ts`. The legacy `inventory.product-stock.get` routing key is removed entirely. The legacy `inventory.order.confirm` routing key is **kept but reshaped into a deprecation handler** — any caller still hitting it gets a deterministic typed error rather than a missing-handler 404; `epic-07` repurposes the routing key for the Reservation flow.

Three call sites get swept up: the two mutator use cases (`receive-stock` and `adjust-stock`) get a publisher-port injection point that emits the corresponding event after the cache-invalidation completes; the auto-init use case (task-07) gets its inline routing-key literal replaced with the constant + delegates to the publisher class instead of calling `ClientProxy.emit()` directly; the existing `publishStockLow` call site is updated to consume the new event-class shape. The legacy `inventory.product-stock.get` RPC handler in `stock.controller.ts` is deleted.

## Entry state assumed

Task-07 carryover present:

- `AutoInitStockLevelUseCase` exists and emits `inventory.stock-level.initialized` via an **inline string literal** routing key, calling `ClientProxy.emit()` directly (no publisher port).
- `VariantCreatedConsumer` is wired and consuming `catalog.variant.created`.
- `ReceiveStockUseCase` and `AdjustStockUseCase` have **no event-emission call** today (task-05 leaves the emit-line as a TODO comment).
- `StockRabbitmqPublisher` (the pre-epic-04 file) still exists at `apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts`. Its `publishStockLow` method emits against `ROUTING_KEYS.INVENTORY_STOCK_LOW` — payload shape uses `productId` (legacy).
- `libs/messaging/routing-keys.constants.ts` carries `INVENTORY_PRODUCT_STOCK_GET`, `INVENTORY_ORDER_CONFIRM`, `INVENTORY_STOCK_LOW` from before the epic. The first two are due for retirement / reshape in this task; the third is preserved with a reshaped payload.
- `libs/contracts/inventory/events/stock-low.event.ts` exists. Restructured by task-04 to be `variantId`-keyed.
- `stock.controller.ts` carries the three new `@MessagePattern` handlers from task-05, the inline routing-key strings still TODO.
- `IStockEventsPublisherPort` (the port file) carries `publishStockLow` and `publishStockReserved` only — the latter is a no-op.

## Scope

**In:**

- `libs/messaging/routing-keys.constants.ts`:
  - **Add** three new entries inside `ROUTING_KEYS`:
    - `INVENTORY_STOCK_RECEIVED: 'inventory.stock.received'`
    - `INVENTORY_STOCK_ADJUSTED: 'inventory.stock.adjusted'`
    - `INVENTORY_STOCK_LEVEL_INITIALIZED: 'inventory.stock-level.initialized'`
  - **Add** three new entries for the RPC-style routing keys the use cases use (the controller's `@MessagePattern` handlers reference them; in task-05 they were inline strings):
    - `INVENTORY_STOCK_RECEIVE: 'inventory.stock.receive'`
    - `INVENTORY_STOCK_ADJUST: 'inventory.stock.adjust'`
    - `INVENTORY_STOCK_QUERY_AVAILABILITY: 'inventory.stock.query-availability'`
  - **Remove** `INVENTORY_PRODUCT_STOCK_GET: 'inventory.product-stock.get'` — no remaining caller after task-05.
  - **Keep** `INVENTORY_ORDER_CONFIRM: 'inventory.order.confirm'` for the deprecation handler (described below); rename it nowhere because epic-07 will repurpose the same string for the Reservation flow.
  - **Keep** `INVENTORY_STOCK_LOW: 'inventory.stock.low'` unchanged.
- New event-payload interfaces at `libs/contracts/inventory/events/`:
  - `stock-received.event.ts` exporting `IInventoryStockReceivedEvent`.
  - `stock-adjusted.event.ts` exporting `IInventoryStockAdjustedEvent`.
  - `stock-level-initialized.event.ts` exporting `IInventoryStockLevelInitializedEvent`.
  - `stock-low.event.ts` already exists; reshape its `IInventoryStockLowEvent` interface to use `variantId` + `stockLocationId` (was `productId` + `storageId`).
- Rewrite `apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts`:
  - Four methods: `publishStockReceived`, `publishStockAdjusted`, `publishStockLevelInitialized`, `publishStockLow`. (The pre-existing no-op `publishStockReserved` is removed entirely — `epic-07` will add it back when the Reservation flow lands; carrying a no-op stub forward bloats the port surface for no benefit.)
  - All four methods route through the same `notificationClient.emit()` pattern (the project ships one queue per microservice; the notification microservice's `stock-low` consumer was the only downstream listener before this epic, and the new audit-log consumer in `epic-11` will subscribe to all four).
  - Each method maps from the domain event class (`StockReceivedEvent`, etc.) to the wire-shape interface (`IInventoryStockReceivedEvent`, etc.).
  - The publisher conserves the project's `correlationId` convention — the second argument carries the per-call correlation id; empty string default matches the existing publisher style.
- Rewrite `apps/inventory-microservice/src/modules/stock/application/ports/stock-events.publisher.port.ts`:
  - `IStockEventsPublisherPort` now exports four method signatures matching the four publisher methods above.
  - The `STOCK_EVENTS_PUBLISHER` DI token is unchanged.
- Inject the publisher into:
  - `ReceiveStockUseCase`: after `cache.withInvalidation` returns the projection, the use case calls `eventsPublisher.publishStockReceived(...)`. The emit is fire-and-forget — `await` is preserved (matches `publishStockLow`'s style) but the use case treats publish-failure as a logged warning, not a hard failure (the row is already committed; the cache is invalidated; a missed audit-log event is recoverable).
  - `AdjustStockUseCase`: same pattern with `publishStockAdjusted`.
  - `AutoInitStockLevelUseCase`: replace the inline `notificationClient.emit('inventory.stock-level.initialized', …)` with `eventsPublisher.publishStockLevelInitialized(...)`. The inline routing-key literal is gone.
- Reshape the legacy `inventory.order.confirm` RPC handler. The current `stock.controller.ts` (post-task-05) has three new handlers (`receive` / `adjust` / `query-availability`) and the old `@MessagePattern(ROUTING_KEYS.INVENTORY_ORDER_CONFIRM)` from before task-05. This task:
  - Deletes the old `@MessagePattern(ROUTING_KEYS.INVENTORY_PRODUCT_STOCK_GET)` handler (already throwing the stub from task-01, deleted by task-05 — verify it is gone).
  - **Replaces** the old `@MessagePattern(ROUTING_KEYS.INVENTORY_ORDER_CONFIRM)` handler with a typed deprecation handler:
    ```ts
    @MessagePattern(ROUTING_KEYS.INVENTORY_ORDER_CONFIRM)
    public handleOrderConfirmDeprecated(@Payload() _payload: unknown): never {
      throw new DeprecatedRpcError(
        'inventory.order.confirm was retired by epic-04 task-08. The routing key is reserved for epic-07 (Reservation flow).',
      );
    }
    ```
  - `DeprecatedRpcError` is added to `apps/inventory-microservice/src/modules/stock/domain/errors/`. RPC callers receive a typed error frame (the project's RMQ adapter materializes the throw as an exception in the caller).
- Update `stock.controller.ts`'s three new handler bodies to point at the constants (`ROUTING_KEYS.INVENTORY_STOCK_RECEIVE`, etc.) instead of the inline strings from task-05. Each `// TODO(epic-04 task-08)` comment is removed in lockstep.
- Update `auto-init-stock-level.use-case.ts`: drop the `MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE` injection; inject `STOCK_EVENTS_PUBLISHER` instead; the emit-line becomes `await this.eventsPublisher.publishStockLevelInitialized(...)`.
- Update `stock.module.ts`: no provider changes (the publisher is already registered); only the consumer-of-publisher dependency graph gets wider.
- Update `libs/messaging/spec/routing-keys.constants.spec.ts` to assert (a) the three new keys exist, (b) the three new RPC-style keys exist, (c) `INVENTORY_PRODUCT_STOCK_GET` is gone, (d) `INVENTORY_ORDER_CONFIRM` is still present.
- **Append** sections to two existing doc files: `06-receive-and-adjust-use-cases.md` (the emitted-event shape for `inventory.stock.received` and `inventory.stock.adjusted`) and `05-auto-init-on-variant-created.md` (the routing-key constant for the level-initialized event + the deprecation handler note for `inventory.order.confirm`).

**Out:**

- The api-gateway side — task-09.
- New ports / new ADRs — none added in this task.
- The audit-log consumer of the three new events — `epic-11`.

## `libs/messaging/routing-keys.constants.ts` — concrete after-state

```ts
export const ROUTING_KEYS = {
  // -- retail (unchanged) --
  RETAIL_ORDER_CREATE: 'retail.order.create',
  RETAIL_ORDER_CONFIRM: 'retail.order.confirm',
  RETAIL_ORDER_GET: 'retail.order.get',
  RETAIL_ORDER_CREATED: 'retail.order.created',
  RETAIL_ORDER_CONFIRMED: 'retail.order.confirmed',
  RETAIL_ORDER_CANCELLED: 'retail.order.cancelled',

  // -- inventory (post epic-04 task-08) --
  // RPC-style (request/reply) — used by stock.controller.ts @MessagePattern handlers
  INVENTORY_STOCK_RECEIVE: 'inventory.stock.receive',
  INVENTORY_STOCK_ADJUST: 'inventory.stock.adjust',
  INVENTORY_STOCK_QUERY_AVAILABILITY: 'inventory.stock.query-availability',
  // Event-style (fire-and-forget broadcast) — used by stock-rabbitmq.publisher.ts
  INVENTORY_STOCK_RECEIVED: 'inventory.stock.received',
  INVENTORY_STOCK_ADJUSTED: 'inventory.stock.adjusted',
  INVENTORY_STOCK_LEVEL_INITIALIZED: 'inventory.stock-level.initialized',
  INVENTORY_STOCK_LOW: 'inventory.stock.low',
  // Deprecation gate — epic-07 will repurpose for the Reservation flow.
  INVENTORY_ORDER_CONFIRM: 'inventory.order.confirm',

  // -- catalog (unchanged from epic-02) --
  // The CATALOG_VARIANT_CREATED constant lives here per epic-02 task-03.
  // Re-cited in this file as the consumer (task-07) binds against it.

  // -- notification (unchanged) --
  NOTIFICATION_HEALTH_PING: 'notification.health.ping',
} as const;

export type RoutingKey = (typeof ROUTING_KEYS)[keyof typeof ROUTING_KEYS];
```

The dotted shape (`inventory.stock.received` etc.) honors ADR-008's routing-key naming convention. The RPC-style vs event-style segments share the same namespace; the **convention** is that RPCs use the verb form (`receive`, `adjust`, `query-availability`) and events use the past tense (`received`, `adjusted`, `level.initialized`). The pair `INVENTORY_STOCK_RECEIVE` + `INVENTORY_STOCK_RECEIVED` looks like a typo at first glance; the convention is what makes them readable as two different concerns.

## `libs/contracts/inventory/events/stock-received.event.ts` — concrete shape

```ts
export interface IInventoryStockReceivedEvent {
  variantId: number;
  stockLocationId: string;
  quantityDelta: number; // strictly positive
  newOnHand: number;
  actorId: string | null;
  eventVersion: 'v1';
  occurredAt: string; // ISO 8601
  correlationId: string;
}
```

`stock-adjusted.event.ts`: same shape plus `reasonCode: string`.

`stock-level-initialized.event.ts`: only the variant + location + correlation id (no quantity field — the value is implicitly `0`):

```ts
export interface IInventoryStockLevelInitializedEvent {
  variantId: number;
  stockLocationId: string;
  eventVersion: 'v1';
  occurredAt: string;
  correlationId: string;
}
```

`stock-low.event.ts` (reshape of an existing file):

```ts
export interface IInventoryStockLowEvent {
  variantId: number;          // was productId
  stockLocationId: string;    // was storageId
  quantity: number;           // available, not onHand
  threshold: number;
  eventVersion: 'v1';
  occurredAt: string;
  correlationId: string;
}
```

The notification microservice consumer of `inventory.stock.low` (which lives outside this epic's scope but is referenced) must be updated to consume the new field names. Verify the consumer file under `apps/notification-microservice/` and update its payload type — this is a small mechanical change; if the consumer file currently imports `IInventoryStockLowEvent` from `libs/contracts/inventory/events`, the type-system surfaces the breakage immediately. The notification consumer update is part of this task's scope (it lives one repo away in the same monorepo).

## `stock-rabbitmq.publisher.ts` — concrete shape

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IInventoryStockAdjustedEvent,
  IInventoryStockLevelInitializedEvent,
  IInventoryStockLowEvent,
  IInventoryStockReceivedEvent,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  StockAdjustedEvent,
  StockLevelInitializedEvent,
  StockLowEvent,
  StockReceivedEvent,
} from '../../domain';
import { IStockEventsPublisherPort } from '../../application/ports';

@Injectable()
export class StockRabbitmqPublisher implements IStockEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
  ) {}

  public async publishStockReceived(event: StockReceivedEvent, correlationId?: string): Promise<void> {
    const wire: IInventoryStockReceivedEvent = {
      variantId: event.variantId,
      stockLocationId: event.stockLocationId,
      quantityDelta: event.quantityDelta,
      newOnHand: event.newOnHand,
      actorId: event.actorId,
      eventVersion: 'v1',
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };
    await firstValueFrom(this.notificationClient.emit(ROUTING_KEYS.INVENTORY_STOCK_RECEIVED, wire));
  }

  public async publishStockAdjusted(event: StockAdjustedEvent, correlationId?: string): Promise<void> {
    // Same mapping as `publishStockReceived` plus `reasonCode` from the domain event.
  }

  public async publishStockLevelInitialized(
    event: StockLevelInitializedEvent,
    correlationId?: string,
  ): Promise<void> {
    // Mapping omitted for brevity; same pattern.
  }

  public async publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void> {
    // Pre-existing — payload field-names updated from productId/storageId.
  }
}
```

The pre-existing `publishStockReserved(event, correlationId)` no-op method is removed; the corresponding `StockReservedEvent` import is removed. The `Promise.resolve()` body was a no-op; `epic-07` re-adds the method when the Reservation flow lands.

## `IStockEventsPublisherPort` — concrete shape

```ts
import {
  StockAdjustedEvent,
  StockLevelInitializedEvent,
  StockLowEvent,
  StockReceivedEvent,
} from '../../domain';

export const STOCK_EVENTS_PUBLISHER = Symbol('STOCK_EVENTS_PUBLISHER');

export interface IStockEventsPublisherPort {
  publishStockReceived(event: StockReceivedEvent, correlationId?: string): Promise<void>;
  publishStockAdjusted(event: StockAdjustedEvent, correlationId?: string): Promise<void>;
  publishStockLevelInitialized(
    event: StockLevelInitializedEvent,
    correlationId?: string,
  ): Promise<void>;
  publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void>;
}
```

## `ReceiveStockUseCase` + `AdjustStockUseCase` — publisher injection + emit call

The constructor gains an `@Inject(STOCK_EVENTS_PUBLISHER) private readonly eventsPublisher: IStockEventsPublisherPort` parameter. The body adds, after the `cache.withInvalidation(...)` returns:

```ts
const events = level.pullDomainEvents();
for (const event of events) {
  // The publisher's switch on the concrete event class lives inside the
  // publisher; the use case just iterates the drain. A `try/catch` here
  // logs publish failure as a warning but does not throw — the row is
  // committed and the cache is invalidated; a missed event is recoverable
  // via epic-11's audit-log replay.
  if (event instanceof StockReceivedEvent) {
    try { await this.eventsPublisher.publishStockReceived(event, correlationId); }
    catch (error) { this.logger.warn({ err: error as Error }, 'publishStockReceived failed'); }
  } else if (event instanceof StockLowEvent) {
    try { await this.eventsPublisher.publishStockLow(event, correlationId); }
    catch (error) { this.logger.warn({ err: error as Error }, 'publishStockLow failed'); }
  }
}
```

Wait — the use case (post-task-05) doesn't carry the domain aggregate in memory; it uses the atomic UPDATE path through the repository and gets the post-update projection back. The aggregate's `pullDomainEvents()` is exercised by the **test double** repository in `*.use-case.spec.ts`. For the live path, the use case constructs the domain event directly:

```ts
const projection = await this.repository.incrementOnHand({...});
const event = new StockReceivedEvent({
  variantId: projection.variantId,
  stockLocationId: projection.stockLocationId,
  quantityDelta: quantity,
  newOnHand: projection.quantityOnHand,
  actorId,
});
try {
  await this.eventsPublisher.publishStockReceived(event, correlationId);
} catch (error) {
  this.logger.warn({ err: error as Error, variantId, stockLocationId }, 'publishStockReceived failed');
}
```

The test double's aggregate path and the live atomic-UPDATE path both end up calling `publishStockReceived` with the same event payload. The doc deliverable explains the duality.

The `StockLowEvent` emission is governed by the threshold — for this task, the threshold is a configuration value read from env (`INVENTORY_STOCK_LOW_THRESHOLD`, default `10`). The use case checks `projection.available <= threshold` after the UPDATE and emits if true. The current production wiring of `publishStockLow` (which fires the existing notification consumer) does not break.

Same pattern for `AdjustStockUseCase` with `StockAdjustedEvent`.

## `AutoInitStockLevelUseCase` — publisher injection

Replace the inline `notificationClient.emit(...)` with `await this.eventsPublisher.publishStockLevelInitialized(event, correlationId)`. The constructor drops the `MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE` injection. The domain event is constructed from `{ variantId, stockLocationId }`.

## Files to add

- `libs/contracts/inventory/events/stock-received.event.ts`
- `libs/contracts/inventory/events/stock-adjusted.event.ts`
- `libs/contracts/inventory/events/stock-level-initialized.event.ts`
- `apps/inventory-microservice/src/modules/stock/domain/errors/deprecated-rpc.error.ts`

## Files to modify

- `libs/messaging/routing-keys.constants.ts` — per the after-state above.
- `libs/messaging/spec/routing-keys.constants.spec.ts` — assertions updated.
- `libs/contracts/inventory/events/stock-low.event.ts` — field rename to `variantId` / `stockLocationId` + the `eventVersion` / `occurredAt` additions.
- `libs/contracts/inventory/events/index.ts` — re-export the new event interfaces.
- `apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts` — four-method rewrite.
- `apps/inventory-microservice/src/modules/stock/application/ports/stock-events.publisher.port.ts` — four-method port shape.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/receive-stock.use-case.ts` — publisher injection + emit.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/adjust-stock.use-case.ts` — same.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/auto-init-stock-level.use-case.ts` — publisher injection; inline-string + ClientProxy injection both gone.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/receive-stock.use-case.spec.ts` — assert the publisher port is called with the right arguments.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/adjust-stock.use-case.spec.ts` — same.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/auto-init-stock-level.use-case.spec.ts` — assertion updates (publisher port instead of `ClientProxy`).
- `apps/inventory-microservice/src/modules/stock/presentation/stock.controller.ts` — three handler routing keys swap from inline literals to constants; deprecation handler for `INVENTORY_ORDER_CONFIRM` added.
- `apps/notification-microservice/.../<stock-low consumer file>` — type imports realign with the reshaped `IInventoryStockLowEvent`.
- `docs/implementation/epic-04-inventory-stock-level-and-location/06-receive-and-adjust-use-cases.md` — append emitted-event section.
- `docs/implementation/epic-04-inventory-stock-level-and-location/05-auto-init-on-variant-created.md` — append routing-key + deprecation paragraph.

## Files to delete

None (the deprecated `inventory.order.confirm` routing key is kept; the deprecation handler reuses it).

## Tests

- `libs/messaging/spec/routing-keys.constants.spec.ts` — ≥4 new assertions (three keys exist, one is gone, `INVENTORY_ORDER_CONFIRM` is still present).
- `receive-stock.use-case.spec.ts` — extend with publisher-call assertion: ≥1 case asserts `publishStockReceived` was called exactly once with the expected payload. ≥1 case asserts publish failure does not propagate (caught and logged).
- `adjust-stock.use-case.spec.ts` — same pattern with `publishStockAdjusted`.
- `auto-init-stock-level.use-case.spec.ts` — update the existing case to assert `publishStockLevelInitialized` was called (replacing the `ClientProxy.emit` assertion).
- `yarn build` passes across all microservices (notification consumer is updated).
- Manual smoke: receive 50 units → `rabbitmqctl list_bindings` shows the new `inventory.stock.received` key in flight via the notification queue's bindings (or wherever the audit log will eventually bind); the existing `stock.low` flow still fires when the new threshold check trips.

## Doc deliverable

### Appended to `06-receive-and-adjust-use-cases.md` (≥40 lines)

Heading: `## Emitted events`. Subsections:

1. `inventory.stock.received` — routing key + payload schema (the `IInventoryStockReceivedEvent` shape). Why `eventVersion: 'v1'` is part of the payload (so future schema-version bumps can be detected by consumers without changing the routing key — same pattern as ADR-022's cache-key version segment, transposed to event payloads).
2. `inventory.stock.adjusted` — same plus `reasonCode`. Why `reasonCode` is mandatory in the payload even though no DB column persists it yet (the consumer in `epic-11`'s audit log is the durable store).
3. The fire-and-forget contract. Publish failure is logged but not thrown — the row is committed; a missed event is recovered via `epic-11`'s replay tooling.
4. The deprecation note for `inventory.order.confirm`: epic-07 reshapes the routing key for the Reservation flow; today, any caller gets `DeprecatedRpcError`.

### Appended to `05-auto-init-on-variant-created.md` (≥20 lines)

Heading: `## Routing-key constants`. Subsections:

1. `ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED` — the constant for the inline literal previously in `auto-init-stock-level.use-case.ts`.
2. The publisher port discipline — the use case no longer carries a direct `ClientProxy` injection; all RMQ emits go through `IStockEventsPublisherPort`.
3. Forward link to `epic-11`'s audit-log consumer.

## Carryover produced (consumed by task-09 onward)

- Three new routing-key constants in `libs/messaging/routing-keys.constants.ts`.
- Three new event-payload interfaces in `libs/contracts/inventory/events/`.
- `StockRabbitmqPublisher` has four methods; `IStockEventsPublisherPort` matches.
- Three use cases emit through the publisher port; no inline routing-key literals remain.
- `INVENTORY_PRODUCT_STOCK_GET` constant gone.
- `INVENTORY_ORDER_CONFIRM` constant reshaped to a deprecation handler.
- Notification microservice's stock-low consumer realigned to the `variantId` field names.
- Docs 06 + 05 carry the emitted-event sections.

## Exit criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; the publisher assertion cases are green; routing-keys constants spec passes.
- [ ] `yarn build` passes for all microservices including notification.
- [ ] `grep -nR "ROUTING_KEYS.INVENTORY_PRODUCT_STOCK_GET" apps libs` returns zero hits.
- [ ] `grep -nR "'inventory\\.stock-level\\.initialized'" apps` returns zero hits (the inline literal is gone; only the constant remains).
- [ ] Manual smoke: `docker compose up -d && yarn start:dev`, then `rabbitmqctl list_bindings | grep inventory.stock.received` shows the binding (or, depending on the project's exchange topology, the routing-key registration shows up where the audit log will eventually bind).
- [ ] An end-to-end Receive Stock flow (via the api-gateway's pending endpoint from task-09 — verified after task-09 lands) produces one `inventory.stock.received` event observable via `rabbitmqadmin get queue=…`.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc appendices written.
