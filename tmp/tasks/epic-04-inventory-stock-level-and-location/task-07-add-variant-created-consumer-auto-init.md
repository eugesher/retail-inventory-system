---
epic: epic-04
task_number: 7
title: Add the catalog.variant.created consumer + auto-init StockLevel
depends_on: [01, 02, 03, 04, 05, 06]
doc_deliverable: docs/implementation/epic-04-inventory-stock-level-and-location/05-auto-init-on-variant-created.md
---

# Task 07 — Add the `catalog.variant.created` consumer + `AutoInitStockLevelUseCase`

## Goal

Wire the inventory microservice to subscribe to `catalog.variant.created` (the event registered by epic-02 task-03) and, on each receipt, **insert a `StockLevel` row at the default warehouse with `quantityOnHand = 0`** for the new variant. The operation is idempotent — repeat events do not duplicate rows, because the `(variant_id, stock_location_id)` unique index in `stock_level` plus an `INSERT ... ON DUPLICATE KEY UPDATE id = id` (or the TypeORM equivalent) guarantees insert-or-noop. The use case also emits an `inventory.stock-level.initialized` RMQ event so downstream consumers (audit log in `epic-11`) can observe the initialization. The emit-side wiring of that routing key lives in task-08; this task uses an inline string literal with a TODO marker.

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

## Scope

**In:**

- New use case `apps/inventory-microservice/src/modules/stock/application/use-cases/auto-init-stock-level.use-case.ts` + spec under `application/use-cases/spec/`.
- New consumer (Nest `@EventPattern()` handler) under `apps/inventory-microservice/src/modules/stock/infrastructure/consumers/variant-created.consumer.ts`. The handler subscribes to `CATALOG_VARIANT_CREATED` (the existing routing-key constant from epic-02 task-03) and delegates to the use case.
- The consumer's queue binding is added to the inventory microservice's RMQ setup. Concretely: `libs/messaging/microservice-client-inventory.module.ts` (or the analogous configuration file the project uses for the inventory queue) gets a routing-key entry for `CATALOG_VARIANT_CREATED`, bound through the catalog exchange (`catalog.*`). The inventory microservice's queue (currently `inventory_queue`) is extended; no new queue is created (one queue per microservice is the project pattern — verify against the `MicroserviceQueueEnum` values).
- New event class `apps/inventory-microservice/src/modules/stock/domain/events/stock-level-initialized.event.ts` was added by task-04. This task wires the publisher-side emit-call inline with an inline-string routing key (`'inventory.stock-level.initialized'`); task-08 swaps to the constant.
- Update `stock.module.ts` to register the consumer + the new use case.
- Doc deliverable `05-auto-init-on-variant-created.md`.

**Out:**

- Registering the three new routing keys (`inventory.stock.received`, `inventory.stock.adjusted`, `inventory.stock-level.initialized`) in `libs/messaging/routing-keys.constants.ts` — task-08.
- The full `stock-rabbitmq.publisher.ts` rewrite — task-08. This task uses the **existing** publisher's `publishStockLow` method as a template and writes the `inventory.stock-level.initialized` emit inline; task-08 refactors all the emits into one publisher.
- The api-gateway side — task-09. (No api-gateway endpoint creates a Variant; that lives in `catalog-microservice` post epic-02. The api-gateway's role here is to call `POST /api/catalog/variants` and observe — within seconds — that `GET /api/inventory/variants/:id/stock` returns `{ quantityOnHand: 0, available: 0 }` for the new variant. The e2e test for this is added in task-10.)
- The lazy re-init code path — not in this epic.

## `auto-init-stock-level.use-case.ts` shape

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { MicroserviceClientTokenEnum } from '@retail-inventory-system/messaging';

import { StockLevel } from '../../domain';
import {
  IStockRepositoryPort,
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
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
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

    // Inline emit — task-08 refactors this into the StockRabbitmqPublisher.
    // The routing key is hardcoded today; task-08 replaces with
    // ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED.
    await firstValueFrom(
      this.notificationClient.emit(
        'inventory.stock-level.initialized', // TODO(epic-04 task-08)
        { variantId, stockLocationId, eventVersion: 'v1', correlationId: correlationId ?? '' },
      ),
    );
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
- The event is emitted **outside** the `try { save } catch` block so a save that "lost the race" does not double-emit (each racer emits exactly once, but only the racer that won the insert reaches the emit line). If both racers won via different connection-level deferred validation (rare on MySQL InnoDB; impossible on the unique index here), the duplicate-emit consumers downstream are responsible for their own idempotency — `epic-11`'s audit log uses event IDs.
- The publisher client used here is the same `NOTIFICATION_MICROSERVICE` client that `stock-rabbitmq.publisher.ts` injects. Task-08 consolidates both call sites onto a single publisher class; for now the duplication is acceptable to keep this task small.

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
- `docs/implementation/epic-04-inventory-stock-level-and-location/05-auto-init-on-variant-created.md`

## Files to modify

- `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts` — register the consumer + the use case.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/index.ts` — re-export `AutoInitStockLevelUseCase`.
- `libs/messaging/microservice-client-inventory.module.ts` (or its analog) — bind the `catalog.variant.created` routing key.
- `libs/messaging/spec/routing-keys.constants.spec.ts` — if the spec asserts the set of bound keys per microservice, update.

## Files to delete

None.

## Tests

- `auto-init-stock-level.use-case.spec.ts` — ≥6 cases:
  1. Happy path: no row exists; save inserts; event emit fires.
  2. Idempotent path: row exists; save is not called; event emit does not fire.
  3. Race path: save throws errno 1062; treated as success; event emit does not fire.
  4. Save throws any other error; the error propagates; event emit does not fire.
  5. The emitted payload carries `variantId`, `stockLocationId = 'default-warehouse'`, `eventVersion: 'v1'`, and the supplied `correlationId`.
  6. Missing `correlationId` does not fail (defaults to empty string in the emit payload).
- A consumer-level spec is not added (the `@EventPattern` handler is a thin wrapper). The integration is exercised by the e2e test in task-10.
- `yarn build:inventory-microservice` succeeds.
- Boot smoke: `docker compose up -d && yarn start:dev:inventory-microservice` boots; an `rabbitmqctl list_bindings | grep catalog.variant.created` shows the new binding on the inventory queue.

## Doc deliverable

Write `docs/implementation/epic-04-inventory-stock-level-and-location/05-auto-init-on-variant-created.md`. Target ~160 lines. Sections:

1. **The auto-init contract.** On `catalog.variant.created`, the inventory microservice inserts a `StockLevel = 0` row at the auto-provisioned `default-warehouse`. This is the only path by which a `StockLevel` row is created in normal operation. The test seed (task-10) is the out-of-band exception, and the e2e tests assert both paths.
2. **The two-call idempotency dance.** The find-then-save approach. Why not `INSERT ... ON DUPLICATE KEY UPDATE`: that idiom makes it ambiguous whether the row was created or already existed, and the event-emission decision needs that signal. Why the errno-1062 race fallback is correctness-preserving (both racers achieve the same end-state; only the winner emits; if both somehow emit, downstream consumers use event IDs).
3. **The default location is hardcoded.** `'default-warehouse'` is the only target. Why no policy-driven default selection in this epic (out of universal core; an `IStockLocationSelectionPolicy` port is a future addition). Cross-link `02-default-stocklocation-auto-provision.md` for the seeded row.
4. **The emit-on-success contract.** `inventory.stock-level.initialized` fires only when the row is newly inserted, not on idempotent skip. `epic-11`'s audit log uses this event for compliance retention. The event payload shape: `{ variantId, stockLocationId, eventVersion: 'v1', correlationId }`. Task-08 will document the routing-key constant and the publisher refactor.
5. **The queue binding.** `inventory_queue` now binds `catalog.variant.created` against the catalog exchange. The binding is explicit (not `catalog.variant.*`) so future `catalog.variant.updated` / `catalog.variant.archived` events do not silently drop. When a new catalog-side event lands, the inventory team adds the matching consumer + binding in lockstep — the explicit-binding rule is the safety net.
6. **What happens when the consumer is down at variant-create time.** RabbitMQ retains the event in `inventory_queue` (durable). When the consumer restarts, it processes the backlog. The variant has no `StockLevel` row during the gap, so any `Receive Stock` / `Adjust Stock` call against that variant in that window will fail with `StockInvariantViolationError` (zero rows affected on the atomic UPDATE; the use case throws). This is acceptable for the walking skeleton — a "lazy re-init" code path (insert the row inside `ReceiveStock` if missing) is a future-work item, not deferred to epic-07 explicitly because the operational gap is short. Cross-link `epic-11`'s message-replay tooling as the production-grade recovery path.
7. **What happens on duplicate events.** RabbitMQ at-least-once delivery means a consumer might see the same `catalog.variant.created` twice (network blip, broker restart). The idempotency contract above absorbs the duplicate without side effects.
8. **Forward links.** Task-08 (the publisher refactor that swaps the inline routing-key literal in `auto-init-stock-level.use-case.ts` for `ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED`). Task-10 (the e2e test that exercises the catalog → inventory flow end-to-end).

Task-08 appends a short paragraph here on the emit-side routing-key constant; the rest is owned by this task.

## Carryover produced (consumed by task-08 onward)

- `AutoInitStockLevelUseCase` exists; its spec has ≥6 cases green.
- `VariantCreatedConsumer` exists under `infrastructure/consumers/`; registered in `stock.module.ts`.
- The inventory queue binds `catalog.variant.created`.
- The use case emits `'inventory.stock-level.initialized'` as an inline routing-key string; task-08 swaps to the constant.
- Doc `05-auto-init-on-variant-created.md` exists with sections 1–8 above filled.

## Exit criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; the new auto-init spec is green with ≥6 cases.
- [ ] `yarn build:inventory-microservice` succeeds.
- [ ] `yarn start:dev:inventory-microservice` boots; the inventory queue's bindings include `catalog.variant.created` (verified by `rabbitmqctl list_bindings`).
- [ ] Manual smoke: publish a synthetic `catalog.variant.created` event with a fresh `variantId`; observe one log line `StockLevel auto-init complete`; `SELECT * FROM stock_level WHERE variant_id = ?` returns one row with `quantity_on_hand = 0` and `version = 0`.
- [ ] Re-publishing the same event produces one log line `StockLevel already exists for variant; auto-init skipped`; the row count is unchanged.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `05-auto-init-on-variant-created.md` exists with the eight sections above filled.
