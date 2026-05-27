---
epic: epic-04
task_number: 8
title: Wire the new RabbitMQ publisher — three new routing keys + cleanup of legacy ones
depends_on: [01, 02, 03, 04, 05, 06, 07]
doc_deliverable: appended to docs/implementation/epic-04-inventory-stock-level-and-location/06-receive-and-adjust-use-cases.md and 05-auto-init-on-variant-created.md
---

# Task 08 — Wire the new RMQ publisher

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Consolidate the inventory microservice's emit-side wiring around a single `StockRabbitmqPublisher` class that emits all four `inventory.*` events the epic introduces or preserves: `stock.received`, `stock.adjusted` (the two new ones added in this task), `stock-level.initialized` (added in task-07 — kept as is here), and `stock.low` (the pre-existing one — payload reshaped to be `variantId`-keyed, target consumer unchanged). The two new routing keys added by this task are registered in `libs/messaging/routing-keys.constants.ts` (`INVENTORY_STOCK_LEVEL_INITIALIZED` was registered in task-07 — keep it). The legacy `inventory.product-stock.get` routing key is removed entirely. The legacy `inventory.order.confirm` routing key is **kept but reshaped into a deprecation handler** — any caller still hitting it gets a deterministic typed error rather than a missing-handler 404; `epic-07` repurposes the routing key for the Reservation flow.

Two call sites get swept up: the two mutator use cases (`receive-stock` and `adjust-stock`) get a publisher-port injection point that emits the corresponding event after the cache-invalidation completes; the existing `publishStockLow` call site is updated to consume the new event-class shape. The auto-init use case (task-07) already routes through the publisher port — this task does not touch it (the original "inline literal swap" step was moved forward into task-07 because the deferred-`ClientProxy`-in-use-case shape contradicted ADR-008 §"Domain code depends on a publisher port (deferred)"; see `epic-00/task-10`). The legacy `inventory.product-stock.get` RPC handler in `stock.controller.ts` is deleted.

## Entry state assumed

Task-07 carryover present:

- `AutoInitStockLevelUseCase` exists and routes its emit through `IStockEventsPublisherPort.publishStockLevelInitialized` (no `ClientProxy` injection in the use case; no inline routing-key literal). This task **does not touch** the auto-init use case.
- `ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED: 'inventory.stock-level.initialized'` is already registered in `libs/messaging/routing-keys.constants.ts` (added by task-07). This task **does not** re-register it.
- `IStockEventsPublisherPort` carries three methods after task-07: `publishStockLow`, `publishStockReserved` (the pre-epic no-op), and `publishStockLevelInitialized` (added by task-07). This task drops `publishStockReserved` and adds two more (`publishStockReceived`, `publishStockAdjusted`); the net surface after this task is **four methods**.
- `StockRabbitmqPublisher` already implements `publishStockLevelInitialized` (added by task-07). This task adds the two new methods and reshapes the `publishStockLow` payload mapping; the `publishStockLevelInitialized` body is left as-is.
- `IInventoryStockLevelInitializedEvent` already lives at `libs/contracts/inventory/events/stock-level-initialized.event.ts` (added by task-07). This task **does not** re-add or modify it.
- `VariantCreatedConsumer` is wired and consuming `catalog.variant.created`.
- `ReceiveStockUseCase` and `AdjustStockUseCase` have **no event-emission call** today (task-05 leaves the emit-line as a TODO comment).
- `libs/messaging/routing-keys.constants.ts` carries `INVENTORY_PRODUCT_STOCK_GET`, `INVENTORY_ORDER_CONFIRM`, `INVENTORY_STOCK_LOW` from before the epic. The first two are due for retirement / reshape in this task; the third is preserved with a reshaped payload.
- `libs/contracts/inventory/events/stock-low.event.ts` exists. Restructured by task-04 to be `variantId`-keyed.
- `stock.controller.ts` carries the three new `@MessagePattern` handlers from task-05, the inline routing-key strings still TODO.

## Scope

**In:**

- `libs/messaging/routing-keys.constants.ts`:
  - **Add** two new entries inside `ROUTING_KEYS`:
    - `INVENTORY_STOCK_RECEIVED: 'inventory.stock.received'`
    - `INVENTORY_STOCK_ADJUSTED: 'inventory.stock.adjusted'`
  - (`INVENTORY_STOCK_LEVEL_INITIALIZED` was added by task-07 — keep it; this task **does not** re-add it.)
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
  - (`stock-level-initialized.event.ts` exporting `IInventoryStockLevelInitializedEvent` was added by task-07 — this task **does not** re-add or modify it.)
  - `stock-low.event.ts` already exists; reshape its `IInventoryStockLowEvent` interface to use `variantId` + `stockLocationId` (was `productId` + `storageId`).
- Rewrite `apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts`:
  - Net result is four methods: `publishStockReceived` (new), `publishStockAdjusted` (new), `publishStockLevelInitialized` (already added by task-07 — kept), `publishStockLow` (existing — payload mapping reshaped to `variantId` / `stockLocationId`). (The pre-existing no-op `publishStockReserved` is removed entirely — `epic-07` will add it back when the Reservation flow lands; carrying a no-op stub forward bloats the port surface for no benefit.)
  - All four methods route through the same `notificationClient.emit()` pattern (the project ships one queue per microservice; the notification microservice's `stock-low` consumer was the only downstream listener before this epic, and the new audit-log consumer in `epic-11` will subscribe to all four).
  - Each method maps from the domain event class (`StockReceivedEvent`, etc.) to the wire-shape interface (`IInventoryStockReceivedEvent`, etc.).
  - The publisher conserves the project's `correlationId` convention — the second argument carries the per-call correlation id; empty string default matches the existing publisher style.
- Rewrite `apps/inventory-microservice/src/modules/stock/application/ports/stock-events.publisher.port.ts`:
  - `IStockEventsPublisherPort` now exports four method signatures matching the four publisher methods above. The `publishStockLevelInitialized` signature (added by task-07) is preserved verbatim; the `publishStockReserved` no-op is dropped.
  - The `STOCK_EVENTS_PUBLISHER` DI token is unchanged.
- Inject the publisher into:
  - `ReceiveStockUseCase`: after `cache.withInvalidation` returns the projection, the use case calls `eventsPublisher.publishStockReceived(...)`. The emit is fire-and-forget — `await` is preserved (matches `publishStockLow`'s style) but the use case treats publish-failure as a logged warning, not a hard failure (the row is already committed; the cache is invalidated; a missed audit-log event is recoverable).
  - `AdjustStockUseCase`: same pattern with `publishStockAdjusted`.
  - (`AutoInitStockLevelUseCase` was already wired against the publisher port in task-07 — this task does **not** modify it. The original "swap inline literal" step is no longer in scope here.)
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
- (`auto-init-stock-level.use-case.ts` is already on the publisher port from task-07 — this task does **not** modify it.)
- Update `stock.module.ts`: no provider changes (the publisher is already registered); only the consumer-of-publisher dependency graph gets wider.
- Update `libs/messaging/spec/routing-keys.constants.spec.ts` to assert (a) the two new event-style keys (`INVENTORY_STOCK_RECEIVED`, `INVENTORY_STOCK_ADJUSTED`) exist, (b) the three new RPC-style keys exist, (c) `INVENTORY_PRODUCT_STOCK_GET` is gone, (d) `INVENTORY_ORDER_CONFIRM` is still present. (The level-initialized key assertion was added by task-07; this task does **not** rewrite that assertion.)
- **Append** sections to two existing doc files: `06-receive-and-adjust-use-cases.md` (the emitted-event shape for `inventory.stock.received` and `inventory.stock.adjusted`) and `05-auto-init-on-variant-created.md` (the cross-event consistency note: all four `inventory.*` events route through `IStockEventsPublisherPort` + the deprecation-handler note for `inventory.order.confirm`).

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
  INVENTORY_STOCK_LEVEL_INITIALIZED: 'inventory.stock-level.initialized', // registered in task-07; shown here for completeness
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

## `AutoInitStockLevelUseCase` — already publisher-port-wired by task-07

This task does **not** modify `auto-init-stock-level.use-case.ts`. Task-07 already wires the use case against `IStockEventsPublisherPort.publishStockLevelInitialized`; the original "swap inline literal for the constant + drop `ClientProxy` injection" step is gone from this task's scope, moved forward to task-07 per `epic-00/task-10`. The publisher-port body (`publishStockLevelInitialized` on `StockRabbitmqPublisher`) is preserved verbatim through this task's reshape — the four-method net surface is `publishStockReceived` (new) + `publishStockAdjusted` (new) + `publishStockLevelInitialized` (from task-07) + `publishStockLow` (reshaped payload mapping).

## Files to add

- `libs/contracts/inventory/events/stock-received.event.ts`
- `libs/contracts/inventory/events/stock-adjusted.event.ts`
- (`libs/contracts/inventory/events/stock-level-initialized.event.ts` was added by task-07 — not added here.)
- `apps/inventory-microservice/src/modules/stock/domain/errors/deprecated-rpc.error.ts`

## Files to modify

- `libs/messaging/routing-keys.constants.ts` — per the after-state above. (`INVENTORY_STOCK_LEVEL_INITIALIZED` was registered in task-07 — keep it.)
- `libs/messaging/spec/routing-keys.constants.spec.ts` — assertions updated for the two new event-style keys + the three new RPC-style keys + the `INVENTORY_PRODUCT_STOCK_GET` removal.
- `libs/contracts/inventory/events/stock-low.event.ts` — field rename to `variantId` / `stockLocationId` + the `eventVersion` / `occurredAt` additions.
- `libs/contracts/inventory/events/index.ts` — re-export the two new event interfaces (`IInventoryStockReceivedEvent`, `IInventoryStockAdjustedEvent`). (`IInventoryStockLevelInitializedEvent` was re-exported by task-07 — keep the existing re-export.)
- `apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts` — add `publishStockReceived` and `publishStockAdjusted`; reshape the `publishStockLow` payload mapping to `variantId` / `stockLocationId`; drop the `publishStockReserved` no-op. (`publishStockLevelInitialized` was added by task-07 — keep it verbatim.)
- `apps/inventory-microservice/src/modules/stock/application/ports/stock-events.publisher.port.ts` — drop `publishStockReserved`; add `publishStockReceived` + `publishStockAdjusted`. Net surface = four methods. (`publishStockLevelInitialized` was added by task-07 — keep it.)
- `apps/inventory-microservice/src/modules/stock/application/use-cases/receive-stock.use-case.ts` — publisher injection + emit.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/adjust-stock.use-case.ts` — same.
- (`apps/inventory-microservice/src/modules/stock/application/use-cases/auto-init-stock-level.use-case.ts` is **not** modified here — it was already wired against `STOCK_EVENTS_PUBLISHER` in task-07.)
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/receive-stock.use-case.spec.ts` — assert the publisher port is called with the right arguments.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/adjust-stock.use-case.spec.ts` — same.
- (`spec/auto-init-stock-level.use-case.spec.ts` was already publisher-port-aware in task-07 — not modified here.)
- `apps/inventory-microservice/src/modules/stock/presentation/stock.controller.ts` — three handler routing keys swap from inline literals to constants; deprecation handler for `INVENTORY_ORDER_CONFIRM` added.
- `apps/notification-microservice/.../<stock-low consumer file>` — type imports realign with the reshaped `IInventoryStockLowEvent`.
- `docs/implementation/epic-04-inventory-stock-level-and-location/06-receive-and-adjust-use-cases.md` — append emitted-event section.
- `docs/implementation/epic-04-inventory-stock-level-and-location/05-auto-init-on-variant-created.md` — append the cross-event-consistency paragraph + deprecation-handler note.

## Files to delete

None (the deprecated `inventory.order.confirm` routing key is kept; the deprecation handler reuses it).

## Tests

- `libs/messaging/spec/routing-keys.constants.spec.ts` — extend with assertions covering: the two new event-style keys (`INVENTORY_STOCK_RECEIVED`, `INVENTORY_STOCK_ADJUSTED`) exist, the three new RPC-style keys exist, `INVENTORY_PRODUCT_STOCK_GET` is gone, `INVENTORY_ORDER_CONFIRM` is still present. (The `INVENTORY_STOCK_LEVEL_INITIALIZED` assertion landed in task-07 — preserve it; don't duplicate.)
- `receive-stock.use-case.spec.ts` — extend with publisher-call assertion: ≥1 case asserts `publishStockReceived` was called exactly once with the expected payload. ≥1 case asserts publish failure does not propagate (caught and logged).
- `adjust-stock.use-case.spec.ts` — same pattern with `publishStockAdjusted`.
- (`auto-init-stock-level.use-case.spec.ts` already asserts `publishStockLevelInitialized` was called — set up in task-07. This task does **not** modify that spec.)
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

Heading: `## Cross-event consistency`. Subsections:

1. After this task lands, **all four** `inventory.*` events (`stock.received`, `stock.adjusted`, `stock-level.initialized`, `stock.low`) route through the same `IStockEventsPublisherPort` surface — single port, single adapter, single set of `ROUTING_KEYS.*` constants. The level-initialized routing key + port method shipped in task-07; this task adds the other two new keys and reshapes `publishStockLow`'s payload to be `variantId`-keyed.
2. The deprecation handler for `inventory.order.confirm` — any RPC caller still hitting the legacy routing key receives a typed `DeprecatedRpcError`. `epic-07` will repurpose the same routing key for the Reservation flow.
3. Forward link to `epic-11`'s audit-log consumer (which subscribes to all four `inventory.*` events).

## Carryover produced (consumed by task-09 onward)

- Two new event-style routing-key constants (`INVENTORY_STOCK_RECEIVED`, `INVENTORY_STOCK_ADJUSTED`) + three new RPC-style constants in `libs/messaging/routing-keys.constants.ts`. (`INVENTORY_STOCK_LEVEL_INITIALIZED` was already carryover from task-07.)
- Two new event-payload interfaces in `libs/contracts/inventory/events/` (`IInventoryStockReceivedEvent`, `IInventoryStockAdjustedEvent`). (`IInventoryStockLevelInitializedEvent` was task-07 carryover.) `IInventoryStockLowEvent` reshaped to `variantId` / `stockLocationId`.
- `StockRabbitmqPublisher` has four methods (`publishStockReceived`, `publishStockAdjusted`, `publishStockLevelInitialized`, `publishStockLow`); `IStockEventsPublisherPort` matches. The pre-epic no-op `publishStockReserved` is gone.
- Three use cases (`ReceiveStockUseCase`, `AdjustStockUseCase`, `AutoInitStockLevelUseCase`) emit through the publisher port; no inline routing-key literals remain anywhere under `apps/inventory-microservice/src/modules/stock/application/`.
- `INVENTORY_PRODUCT_STOCK_GET` constant gone.
- `INVENTORY_ORDER_CONFIRM` constant reshaped to a deprecation handler.
- Notification microservice's stock-low consumer realigned to the `variantId` field names.
- Docs 06 + 05 carry the emitted-event sections / cross-event-consistency appendix.

## Exit criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; the publisher assertion cases are green; routing-keys constants spec passes.
- [ ] `yarn build` passes for all microservices including notification.
- [ ] `grep -nR "ROUTING_KEYS.INVENTORY_PRODUCT_STOCK_GET" apps libs` returns zero hits.
- [ ] `grep -nR "ClientProxy" apps/inventory-microservice/src/modules/stock/application/` returns zero hits (the application layer is `@nestjs/microservices`-free per ADR-008 + ADR-017 — preserved from task-07's carryover and not regressed here).
- [ ] Manual smoke: `docker compose up -d && yarn start:dev`, then `rabbitmqctl list_bindings | grep inventory.stock.received` shows the binding (or, depending on the project's exchange topology, the routing-key registration shows up where the audit log will eventually bind).
- [ ] An end-to-end Receive Stock flow (via the api-gateway's pending endpoint from task-09 — verified after task-09 lands) produces one `inventory.stock.received` event observable via `rabbitmqadmin get queue=…`.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc appendices written.
