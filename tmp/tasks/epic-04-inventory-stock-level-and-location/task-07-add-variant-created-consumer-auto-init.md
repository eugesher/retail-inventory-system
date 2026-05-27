---
epic: epic-04
task_number: 7
title: Add the catalog.variant.created consumer + auto-init StockLevel
depends_on: [01, 02, 03, 04, 05, 06]
doc_deliverable: docs/implementation/epic-04-inventory-stock-level-and-location/05-auto-init-on-variant-created.md
---

# Task 07 — Add the `catalog.variant.created` consumer + `AutoInitStockLevelUseCase`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Wire the inventory microservice to subscribe to `catalog.variant.created` (the event registered by epic-02 task-03) and, on each receipt, **insert a `StockLevel` row at the default warehouse with `quantityOnHand = 0`** for the new variant. The operation is idempotent — repeat events do not duplicate rows, because the `(variant_id, stock_location_id)` unique index in `stock_level` plus an `INSERT ... ON DUPLICATE KEY UPDATE id = id` (or the TypeORM equivalent) guarantees insert-or-noop. The use case also emits an `inventory.stock-level.initialized` RMQ event so downstream consumers (audit log in `epic-11`) can observe the initialization. The emit-side wiring lands **in this task** through the existing publisher-port pattern (`IStockEventsPublisherPort` + `STOCK_EVENTS_PUBLISHER`): the routing-key constant is registered, the port surface grows one method, and `StockRabbitmqPublisher` ships the implementation. The use case takes the port symbol via `@Inject(STOCK_EVENTS_PUBLISHER)`, **never** a raw `ClientProxy`. (The earlier draft of this task instructed an inline `ClientProxy.emit(...)` with a `TODO(epic-04 task-08)` marker; that pattern was retired by ADR-008 §"Domain code depends on a publisher port (deferred)" once the per-service hexagonal re-organisation closed the deferred window — see `epic-00/task-10` for the surfaced contradiction. Task-08 still owns the broader publisher rewrite for the `received` / `adjusted` / `low` events and the legacy-key cleanup, but the slice for `stock-level.initialized` ships here from the start so no use case under `application/use-cases/` ever sits on a `ClientProxy` injection.)

The auto-init is the **only** path by which a `StockLevel` row enters the database in normal operation. The test seed (task-10) inserts rows out-of-band for e2e tests because the RMQ consumer may not be up during seeding. A "lazy re-init" code path is documented in `05-auto-init-on-variant-created.md` but not implemented in this task: if the consumer was down at variant-create time, the first `receive-stock` or `adjust-stock` call against that variant will currently fail with `StockInvariantViolationError` (zero rows affected on the `UPDATE`). Lazy re-init is a future-work item; the epic's "Non-Goals" do not list it as deferred because it does not exist as a concept until the consumer-down scenario surfaces in `epic-11`'s replay tooling.

## Entry state assumed

Task-06 carryover present:

- `INVENTORY_STOCK_KEY_VERSION = 'v2'`; `StockCache` is the full v2 implementation.
- The use case layer is the new three-use-case set (`ReceiveStock`, `AdjustStock`, `QueryAvailability`).
- `StockLevel` aggregate is complete.
- The `stock_level` table exists; the `(variant_id, stock_location_id)` unique index is in place.
- `stock_location` has the seeded `default-warehouse` row.
- Epic-02 has landed (this is the carryover assumed at the epic-frontmatter level — `depends_on: [epic-02]`). The catalog microservice is emitting `catalog.variant.created` on the `catalog.*` exchange. The routing key constant `CATALOG_VARIANT_CREATED` is registered in `libs/messaging/routing-keys.constants.ts` (added by epic-02 task-03).
- A `catalog-queue` is bound for catalog-side consumers, but **no inventory-side queue subscribes to `catalog.variant.created` yet** — this task adds the binding.
- `IStockEventsPublisherPort` + `STOCK_EVENTS_PUBLISHER` DI symbol already exist at `apps/inventory-microservice/src/modules/stock/application/ports/stock-events.publisher.port.ts` (pre-epic surface: `publishStockLow` + `publishStockReserved`). `StockRabbitmqPublisher` already exists at `apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts` and implements that port. This task **extends both** with one additional method, `publishStockLevelInitialized`. The broader port-and-publisher reshape (the four-method rewrite that adds `publishStockReceived` / `publishStockAdjusted` and drops the no-op `publishStockReserved`) is task-08's scope and is not touched here — the additive shape preserves task-08's freedom to reshape later.
- `StockLevelInitializedEvent` (the domain event class) was added by task-04 at `apps/inventory-microservice/src/modules/stock/domain/events/stock-level-initialized.event.ts`. This task is the first caller that constructs an instance of it.

## Scope

**In:**

- New use case `apps/inventory-microservice/src/modules/stock/application/use-cases/auto-init-stock-level.use-case.ts` + spec under `application/use-cases/spec/`. The use case injects **`STOCK_EVENTS_PUBLISHER`** (the existing DI symbol bound to `StockRabbitmqPublisher`) and calls `eventsPublisher.publishStockLevelInitialized(domainEvent, correlationId)`. It **never** injects `ClientProxy` or `MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE` — the `application/use-cases/` layer is `@nestjs/microservices`-free per ADR-008 + ADR-004 (enforced by `eslint-plugin-boundaries` per ADR-017).
- New consumer (Nest `@EventPattern()` handler) under `apps/inventory-microservice/src/modules/stock/infrastructure/consumers/variant-created.consumer.ts`. The handler subscribes to `CATALOG_VARIANT_CREATED` (the existing routing-key constant from epic-02 task-03) and delegates to the use case.
- The consumer's queue binding is added to the inventory microservice's RMQ setup. Concretely: `libs/messaging/microservice-client-inventory.module.ts` (or the analogous configuration file the project uses for the inventory queue) gets a routing-key entry for `CATALOG_VARIANT_CREATED`, bound through the catalog exchange (`catalog.*`). The inventory microservice's queue (currently `inventory_queue`) is extended; no new queue is created (one queue per microservice is the project pattern — verify against the `MicroserviceQueueEnum` values).
- `libs/messaging/routing-keys.constants.ts`: **add** one entry inside `ROUTING_KEYS`:
  - `INVENTORY_STOCK_LEVEL_INITIALIZED: 'inventory.stock-level.initialized'`
  - Task-08 still adds the other two new keys (`INVENTORY_STOCK_RECEIVED`, `INVENTORY_STOCK_ADJUSTED`) and the three RPC-style keys (`INVENTORY_STOCK_RECEIVE`/`ADJUST`/`QUERY_AVAILABILITY`); this task touches only the level-initialized key.
- `libs/messaging/spec/routing-keys.constants.spec.ts`: assert the new constant exists with the expected value.
- New event-payload contract at `libs/contracts/inventory/events/stock-level-initialized.event.ts`:
  ```ts
  export interface IInventoryStockLevelInitializedEvent {
    variantId: number;
    stockLocationId: string;
    eventVersion: 'v1';
    occurredAt: string; // ISO 8601
    correlationId: string;
  }
  ```
  Plus a re-export from `libs/contracts/inventory/events/index.ts`.
- New event class `apps/inventory-microservice/src/modules/stock/domain/events/stock-level-initialized.event.ts` was added by task-04. This task constructs an instance of it inside the use case and hands it to the publisher port.
- **Extend the publisher port** at `apps/inventory-microservice/src/modules/stock/application/ports/stock-events.publisher.port.ts`: add the method `publishStockLevelInitialized(event: StockLevelInitializedEvent, correlationId?: string): Promise<void>`. Keep the existing `publishStockLow` + `publishStockReserved` methods unchanged — task-08 owns the broader port reshape (including dropping the `publishStockReserved` no-op).
- **Extend `StockRabbitmqPublisher`** at `apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts` with the matching method. The implementation mirrors the existing `publishStockLow` shape — `firstValueFrom(this.notificationClient.emit(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED, wire))` — where `wire: IInventoryStockLevelInitializedEvent` is built from the domain-event payload + an ISO-string `occurredAt`.
- Update `stock.module.ts` to register the consumer + the new use case. (`StockRabbitmqPublisher` is already registered against `STOCK_EVENTS_PUBLISHER` — no provider-binding change required.)
- Doc deliverable `05-auto-init-on-variant-created.md`. Section 4 (the emit-on-success contract) now describes the publisher-port path directly, not a deferred-routing-key placeholder. Section 8 forward-links task-08 only for the broader publisher reshape (other emit lines + legacy-key cleanup), not for the level-initialized routing key.

**Out:**

- Registering the **two other** new routing keys (`inventory.stock.received`, `inventory.stock.adjusted`) and the three RPC-style keys (`INVENTORY_STOCK_RECEIVE`/`ADJUST`/`QUERY_AVAILABILITY`) in `libs/messaging/routing-keys.constants.ts` — task-08.
- The full `stock-rabbitmq.publisher.ts` four-method rewrite (`publishStockReceived` / `publishStockAdjusted` / payload-shape reshape on `publishStockLow`) — task-08. This task adds **one** method (`publishStockLevelInitialized`) alongside the existing surface.
- Dropping the no-op `publishStockReserved` from the port + adapter — task-08.
- The legacy `INVENTORY_PRODUCT_STOCK_GET` retirement + the `INVENTORY_ORDER_CONFIRM` deprecation handler — task-08.
- The two corresponding event-payload contracts for `received` + `adjusted` — task-08.
- The api-gateway side — task-09. (No api-gateway endpoint creates a Variant; that lives in `catalog-microservice` post epic-02. The api-gateway's role here is to call `POST /api/catalog/variants` and observe — within seconds — that `GET /api/inventory/variants/:id/stock` returns `{ quantityOnHand: 0, available: 0 }` for the new variant. The e2e test for this is added in task-10.)
- The lazy re-init code path — not in this epic.

## `auto-init-stock-level.use-case.ts` shape

```ts
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { StockLevel, StockLevelInitializedEvent } from '../../domain';
import {
  IStockEventsPublisherPort,
  IStockRepositoryPort,
  STOCK_EVENTS_PUBLISHER,
  STOCK_REPOSITORY,
} from '../ports';

export interface IAutoInitStockLevelPayload {
  variantId: number;
  correlationId?: string;
}

@Injectable()
export class AutoInitStockLevelUseCase {
  private static readonly DEFAULT_STOCK_LOCATION_ID = 'default-warehouse';

  constructor(
    @Inject(STOCK_REPOSITORY) private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_EVENTS_PUBLISHER)
    private readonly eventsPublisher: IStockEventsPublisherPort,
    @InjectPinoLogger(AutoInitStockLevelUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IAutoInitStockLevelPayload): Promise<void> {
    const { variantId, correlationId } = payload;
    const stockLocationId = AutoInitStockLevelUseCase.DEFAULT_STOCK_LOCATION_ID;

    // The two-call idempotency contract: `findByVariantAndLocation` first;
    // if the row already exists, skip the insert and skip the emit.
    // Otherwise `save(new StockLevel({...}))` inserts with `quantityOnHand = 0`.
    //
    // The `save` path uses TypeORM's INSERT under the hood, NOT
    // INSERT ... ON DUPLICATE KEY UPDATE, because the read-before-write
    // dance is what gives us "no event emission on duplicate". The race
    // window between the find and the save can produce a duplicate
    // unique-constraint violation in MySQL — that error is caught and
    // treated as success (the desired end-state is "a row exists at 0";
    // both racers achieve the same end-state).
    const existing = await this.repository.findByVariantAndLocation(variantId, stockLocationId);
    if (existing) {
      this.logger.debug(
        { correlationId, variantId, stockLocationId },
        'StockLevel already exists for variant; auto-init skipped',
      );
      return;
    }
    try {
      const fresh = new StockLevel({
        variantId,
        stockLocationId,
        quantityOnHand: 0,
        quantityAllocated: 0,
        quantityReserved: 0,
        version: 0,
      });
      await this.repository.save(fresh);
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        // Race condition: another consumer (or the test seed) inserted
        // first. The end-state is correct; treat as success and skip the
        // emit so the audit log doesn't get a duplicate Initialized event.
        this.logger.debug(
          { correlationId, variantId, stockLocationId },
          'StockLevel auto-init lost a race; treating as success',
        );
        return;
      }
      throw error;
    }

    this.logger.info(
      { correlationId, variantId, stockLocationId },
      'StockLevel auto-init complete',
    );

    // Publisher-port emit — `StockRabbitmqPublisher` materializes the
    // `ClientProxy.emit(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED, …)`
    // call. The application layer stays @nestjs/microservices-free per
    // ADR-008 + ADR-004; eslint-plugin-boundaries enforces this at CI per
    // ADR-017. The domain event carries `variantId` / `stockLocationId`;
    // the adapter adds `eventVersion: 'v1'` and `occurredAt` (ISO string)
    // when it maps to the wire-shape `IInventoryStockLevelInitializedEvent`.
    const domainEvent = new StockLevelInitializedEvent({ variantId, stockLocationId });
    try {
      await this.eventsPublisher.publishStockLevelInitialized(domainEvent, correlationId);
    } catch (error) {
      // Publish failure is best-effort: the row is committed; a missed
      // audit-log event is recoverable via epic-11's replay tooling. Same
      // policy as `publishStockLow` and the post-commit `retail.order.created`
      // emit in retail's `CreateOrderUseCase` — warn-log, don't throw.
      this.logger.warn(
        { err: error as Error, variantId, stockLocationId, correlationId },
        'publishStockLevelInitialized failed',
      );
    }
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    // MySQL error code 1062 — Duplicate entry. TypeORM surfaces this as
    // QueryFailedError with `(error as any).driverError.errno === 1062`.
    // Encapsulated here so the catch in `execute` can stay one line.
    if (typeof error !== 'object' || error === null) return false;
    const driverError = (error as { driverError?: { errno?: number } }).driverError;
    return driverError?.errno === 1062;
  }
}
```

A few design notes for the implementer to read carefully:

- The two-call idempotency (`findByVariantAndLocation` then `save`) is **not** the most efficient choice. A single `INSERT ... ON DUPLICATE KEY UPDATE id = id` would be one round-trip and serializable. The two-call dance is chosen because it gives us a clean "did we insert" signal that drives the event-emission decision — `INSERT ... ON DUPLICATE KEY UPDATE` makes it ambiguous whether the row was newly created or already existed. The race-window fallback (catch 1062 + treat-as-success) closes the correctness gap.
- The publisher-port call is **outside** the `try { save } catch` block so a save that "lost the race" does not double-emit (each racer emits exactly once, but only the racer that won the insert reaches the publish line). If both racers won via different connection-level deferred validation (rare on MySQL InnoDB; impossible on the unique index here), the duplicate-emit consumers downstream are responsible for their own idempotency — `epic-11`'s audit log uses event IDs.
- The use case does **not** inject `ClientProxy` directly. Per ADR-008 §"Domain code depends on a publisher port (deferred)", once every microservice's per-module hexagonal re-organisation is in place (it is: see `IStockEventsPublisherPort` for stock, `IOrderEventsPublisherPort` for retail, `INotifierPort` for notification), the application layer must route RMQ emits through a publisher port. The same `STOCK_EVENTS_PUBLISHER` symbol that `ReceiveStockUseCase` / `AdjustStockUseCase` will use (task-08) is shared here. The adapter file `stock-rabbitmq.publisher.ts` is the *only* place that imports `@nestjs/microservices`.
- Task-08 still owns the broader publisher-and-port reshape (a four-method port, `publishStockReceived` / `publishStockAdjusted` added, the no-op `publishStockReserved` removed, `publishStockLow`'s payload reshaped to `variantId` / `stockLocationId`). This task's port edit is **additive**: one new method (`publishStockLevelInitialized`) alongside the existing pre-epic surface. The additive shape preserves task-08's freedom to reshape without conflicting with this task.

## `variant-created.consumer.ts` shape

```ts
import { Controller } from '@nestjs/common';
import { EventPattern, Payload, Ctx, RmqContext } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { AutoInitStockLevelUseCase } from '../../application/use-cases/auto-init-stock-level.use-case';

interface ICatalogVariantCreatedEvent {
  variantId: number;
  productId: number;
  sku: string;
  // … the rest of the catalog event payload from epic-02 task-03; this
  // consumer reads `variantId` only.
  correlationId?: string;
}

@Controller()
export class VariantCreatedConsumer {
  constructor(
    private readonly autoInit: AutoInitStockLevelUseCase,
    @InjectPinoLogger(VariantCreatedConsumer.name) private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.CATALOG_VARIANT_CREATED)
  public async handle(
    @Payload() event: ICatalogVariantCreatedEvent,
    @Ctx() ctx: RmqContext,
  ): Promise<void> {
    const channel = ctx.getChannelRef();
    const originalMessage = ctx.getMessage();
    try {
      await this.autoInit.execute({
        variantId: event.variantId,
        correlationId: event.correlationId,
      });
      channel.ack(originalMessage);
    } catch (error) {
      this.logger.error(
        { err: error as Error, variantId: event.variantId, correlationId: event.correlationId },
        'auto-init failed; nacking message',
      );
      // requeue=false sends to DLQ if one is configured; otherwise drop.
      // Project policy on DLQ — verify against the messaging config; the
      // safe default is requeue=true with a max-retry header read at the
      // top of this handler. Match the project's existing consumer pattern
      // (e.g. the notification microservice's stock-low handler).
      channel.nack(originalMessage, false, false);
    }
  }
}
```

The `@EventPattern` decorator (vs `@MessagePattern`) is intentional — `catalog.variant.created` is an event broadcast (fire-and-forget), not an RPC. The handler returns `void`. The manual `channel.ack` / `nack` lets us decide ack-on-success / nack-on-failure explicitly rather than relying on the framework's auto-ack default; this matches the existing notification microservice's stock-low consumer.

## Queue binding update

The `MicroserviceClientInventoryModule` (or whatever the project calls it — check `libs/messaging/microservice-client-inventory.module.ts`) currently binds the inventory queue with routing keys for `inventory.product-stock.get` and `inventory.order.confirm`. Two changes:

- Add a binding for `catalog.variant.created` against the catalog exchange. The inventory microservice now subscribes to events from both its own exchange (publishing its `inventory.stock.*` events; the queue listens to its own emits via the `notification` queue's binding, not its own) and the catalog exchange (new — for the auto-init consumer).
- The binding is wildcard-safe: `catalog.variant.*` would catch future `catalog.variant.updated` / `catalog.variant.archived` events, which the inventory consumer does not handle yet. Use the explicit `catalog.variant.created` binding to avoid silent drops of future events the consumer would need to be extended to handle. (A wildcard binding + an unhandled `@EventPattern` would silently ack-and-drop unhandled keys, which is a footgun.)

The exact wiring depends on the project's message-broker abstraction. Verify against the existing `microservice-client-*.module.ts` files; match the pattern.

## `stock.module.ts` update

```ts
controllers: [StockController, VariantCreatedConsumer],
providers: [
  // ... existing providers from task-05 ...
  ReceiveStockUseCase,
  AdjustStockUseCase,
  QueryAvailabilityUseCase,
  AutoInitStockLevelUseCase, // new
],
```

The `VariantCreatedConsumer` is registered as a controller (Nest's `@Controller()` is the lifecycle host for `@MessagePattern` and `@EventPattern` handlers in the microservice runtime). No separate `consumers/` provider list — the convention is that consumers live under `infrastructure/consumers/` on disk but are registered as `controllers:` in the module.

## Files to add

- `apps/inventory-microservice/src/modules/stock/application/use-cases/auto-init-stock-level.use-case.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/auto-init-stock-level.use-case.spec.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/consumers/variant-created.consumer.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/consumers/index.ts`
- `libs/contracts/inventory/events/stock-level-initialized.event.ts`
- `docs/implementation/epic-04-inventory-stock-level-and-location/05-auto-init-on-variant-created.md`

## Files to modify

- `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts` — register the consumer + the use case.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/index.ts` — re-export `AutoInitStockLevelUseCase`.
- `apps/inventory-microservice/src/modules/stock/application/ports/stock-events.publisher.port.ts` — add the `publishStockLevelInitialized(event: StockLevelInitializedEvent, correlationId?: string): Promise<void>` method to `IStockEventsPublisherPort`. Keep the existing `publishStockLow` + `publishStockReserved` methods unchanged — task-08 owns the broader port reshape.
- `apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts` — add the `publishStockLevelInitialized` implementation matching the existing `publishStockLow` shape.
- `libs/messaging/routing-keys.constants.ts` — add the `INVENTORY_STOCK_LEVEL_INITIALIZED: 'inventory.stock-level.initialized'` entry to `ROUTING_KEYS`.
- `libs/messaging/microservice-client-inventory.module.ts` (or its analog) — bind the `catalog.variant.created` routing key.
- `libs/messaging/spec/routing-keys.constants.spec.ts` — assert the new constant + the bound-keys list per microservice if the spec exercises it.
- `libs/contracts/inventory/events/index.ts` — re-export `IInventoryStockLevelInitializedEvent`.

## Files to delete

None.

## Tests

- `auto-init-stock-level.use-case.spec.ts` — ≥6 cases:
  1. Happy path: no row exists; save inserts; **`publishStockLevelInitialized` is called exactly once** with a `StockLevelInitializedEvent` carrying the expected `variantId` / `stockLocationId` and the supplied `correlationId`.
  2. Idempotent path: row exists; save is not called; **`publishStockLevelInitialized` is not called**.
  3. Race path: save throws errno 1062; treated as success; **`publishStockLevelInitialized` is not called**.
  4. Save throws any other error; the error propagates; **`publishStockLevelInitialized` is not called**.
  5. Publisher-port emission failure (the test double rejects `publishStockLevelInitialized`) is caught and warn-logged; the use case **does not** rethrow (the row is already committed; a missed audit-log event is recoverable).
  6. Missing `correlationId` defaults gracefully (the publisher port is called with `correlationId = undefined`; adapter materializes the empty-string default on the wire shape).
- The test double for `IStockEventsPublisherPort` lives under `application/use-cases/spec/test-doubles.ts` (next to the repository test double); the spec injects it via the `STOCK_EVENTS_PUBLISHER` symbol the same way `reserve-stock-for-order.use-case.spec.ts` injects its other ports.
- A consumer-level spec is not added (the `@EventPattern` handler is a thin wrapper). The integration is exercised by the e2e test in task-10.
- `yarn build:inventory-microservice` succeeds.
- Boot smoke: `docker compose up -d && yarn start:dev:inventory-microservice` boots; an `rabbitmqctl list_bindings | grep catalog.variant.created` shows the new binding on the inventory queue.
- `grep -nR "ClientProxy" apps/inventory-microservice/src/modules/stock/application/` returns zero hits (the application layer is `@nestjs/microservices`-free per ADR-008 + ADR-017).

## Doc deliverable

Write `docs/implementation/epic-04-inventory-stock-level-and-location/05-auto-init-on-variant-created.md`. Target ~160 lines. Sections:

1. **The auto-init contract.** On `catalog.variant.created`, the inventory microservice inserts a `StockLevel = 0` row at the auto-provisioned `default-warehouse`. This is the only path by which a `StockLevel` row is created in normal operation. The test seed (task-10) is the out-of-band exception, and the e2e tests assert both paths.
2. **The two-call idempotency dance.** The find-then-save approach. Why not `INSERT ... ON DUPLICATE KEY UPDATE`: that idiom makes it ambiguous whether the row was created or already existed, and the event-emission decision needs that signal. Why the errno-1062 race fallback is correctness-preserving (both racers achieve the same end-state; only the winner emits; if both somehow emit, downstream consumers use event IDs).
3. **The default location is hardcoded.** `'default-warehouse'` is the only target. Why no policy-driven default selection in this epic (out of universal core; an `IStockLocationSelectionPolicy` port is a future addition). Cross-link `02-default-stocklocation-auto-provision.md` for the seeded row.
4. **The emit-on-success contract.** `inventory.stock-level.initialized` fires only when the row is newly inserted, not on idempotent skip. `epic-11`'s audit log uses this event for compliance retention. The event payload shape (the wire interface `IInventoryStockLevelInitializedEvent`): `{ variantId, stockLocationId, eventVersion: 'v1', occurredAt, correlationId }`. The use case constructs a `StockLevelInitializedEvent` (domain class) and hands it to `IStockEventsPublisherPort.publishStockLevelInitialized`; `StockRabbitmqPublisher` maps the domain shape to the wire shape (adds `eventVersion: 'v1'` + `occurredAt` ISO string) and `emit()`s against `ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED`. The routing-key constant is registered in this task (not deferred to task-08), so no inline string literal ever appears in the use case. The application layer stays `@nestjs/microservices`-free per ADR-008 + ADR-017.
5. **The queue binding.** `inventory_queue` now binds `catalog.variant.created` against the catalog exchange. The binding is explicit (not `catalog.variant.*`) so future `catalog.variant.updated` / `catalog.variant.archived` events do not silently drop. When a new catalog-side event lands, the inventory team adds the matching consumer + binding in lockstep — the explicit-binding rule is the safety net.
6. **What happens when the consumer is down at variant-create time.** RabbitMQ retains the event in `inventory_queue` (durable). When the consumer restarts, it processes the backlog. The variant has no `StockLevel` row during the gap, so any `Receive Stock` / `Adjust Stock` call against that variant in that window will fail with `StockInvariantViolationError` (zero rows affected on the atomic UPDATE; the use case throws). This is acceptable for the walking skeleton — a "lazy re-init" code path (insert the row inside `ReceiveStock` if missing) is a future-work item, not deferred to epic-07 explicitly because the operational gap is short. Cross-link `epic-11`'s message-replay tooling as the production-grade recovery path.
7. **What happens on duplicate events.** RabbitMQ at-least-once delivery means a consumer might see the same `catalog.variant.created` twice (network blip, broker restart). The idempotency contract above absorbs the duplicate without side effects.
8. **Forward links.** Task-08 (the broader publisher reshape — adding `publishStockReceived` / `publishStockAdjusted` / dropping the no-op `publishStockReserved` / payload-shape change on `publishStockLow` / retirement of `INVENTORY_PRODUCT_STOCK_GET` / deprecation handler for `INVENTORY_ORDER_CONFIRM`). Task-10 (the e2e test that exercises the catalog → inventory flow end-to-end). The level-initialized routing key + port method + adapter method all ship in **this** task — task-08 only appends a paragraph here covering the cross-event consistency (all four `inventory.*` events route through the same port surface) and the deprecation-handler note.

## Carryover produced (consumed by task-08 onward)

- `AutoInitStockLevelUseCase` exists; its spec has ≥6 cases green.
- `VariantCreatedConsumer` exists under `infrastructure/consumers/`; registered in `stock.module.ts`.
- The inventory queue binds `catalog.variant.created`.
- `ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED` is registered in `libs/messaging/routing-keys.constants.ts`.
- `IStockEventsPublisherPort.publishStockLevelInitialized` is in the port surface (additive — alongside the pre-epic `publishStockLow` + `publishStockReserved`).
- `StockRabbitmqPublisher.publishStockLevelInitialized` is implemented.
- `IInventoryStockLevelInitializedEvent` exists at `libs/contracts/inventory/events/stock-level-initialized.event.ts` and is re-exported from the events index.
- The use case routes the emit through `IStockEventsPublisherPort`; no `ClientProxy` injection, no inline routing-key literal, no `TODO(epic-04 task-08)` markers in the use case.
- Doc `05-auto-init-on-variant-created.md` exists with sections 1–8 above filled.

## Exit criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; the new auto-init spec is green with ≥6 cases (including the publisher-port-call and the publish-failure-swallowing cases).
- [ ] `yarn build:inventory-microservice` succeeds.
- [ ] `yarn start:dev:inventory-microservice` boots; the inventory queue's bindings include `catalog.variant.created` (verified by `rabbitmqctl list_bindings`).
- [ ] Manual smoke: publish a synthetic `catalog.variant.created` event with a fresh `variantId`; observe one log line `StockLevel auto-init complete`; `SELECT * FROM stock_level WHERE variant_id = ?` returns one row with `quantity_on_hand = 0` and `version = 0`; the notification queue (or wherever the audit log will eventually bind) shows one `inventory.stock-level.initialized` event.
- [ ] Re-publishing the same event produces one log line `StockLevel already exists for variant; auto-init skipped`; the row count is unchanged; no second `inventory.stock-level.initialized` event is emitted.
- [ ] `grep -nR "ClientProxy" apps/inventory-microservice/src/modules/stock/application/` returns zero hits (the application layer stays `@nestjs/microservices`-free per ADR-008 + ADR-017).
- [ ] `grep -nR "'inventory\\.stock-level\\.initialized'" apps/inventory-microservice/src/modules/stock/application/` returns zero hits (the routing-key string lives only in `libs/messaging/routing-keys.constants.ts`; the use case references the constant, the adapter emits against the constant).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `05-auto-init-on-variant-created.md` exists with the eight sections above filled.
