---
epic: epic-00
task_number: 10
title: Collapse `epic-04/task-07` and `epic-04/task-08` so `AutoInitStockLevelUseCase` ships with a publisher port from the start
depends_on: []
doc_deliverable: null
---

# Task 10 — Fix `epic-04/task-07` `ClientProxy` injection in a use-case (ADR-008 publisher-port rule)

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** Open ADR-008 (§"Domain code depends on a publisher port (deferred)"), ADR-004, and ADR-012 in full before editing. CLAUDE.md §"Microservices" and §"Boundary rule" describe the live publisher-port pattern (`IStockEventsPublisherPort` + `STOCK_EVENTS_PUBLISHER` symbol) that every existing microservice follows.

## ADR audited

[ADR-008 — RabbitMQ wiring via `libs/messaging` and dotted routing keys](../../../docs/adr/008-rabbitmq-via-libs-messaging.md). Accepted (2026-05-10).

## Contradiction

`tmp/tasks/epic-04-inventory-stock-level-and-location/task-07-add-variant-created-consumer-auto-init.md` (lines 54-95) instructs the implementer to add `AutoInitStockLevelUseCase` under `apps/inventory-microservice/src/modules/stock/application/use-cases/` and to inject `ClientProxy` from `@nestjs/microservices` directly into the use-case constructor. The use-case body then calls `firstValueFrom(this.notificationClient.emit('inventory.stock-level.initialized', …))` against an inline string literal routing key.

This contradicts ADR-008 §"Domain code depends on a publisher port (deferred)" — the decision text explicitly retires this pattern: "Per ADR-004 the long-term shape is: Domain layer defines `IMessagePublisher` (or similar). An adapter in `libs/messaging` (or app-side) implements it via `ClientProxy`. Domain code never imports `@nestjs/microservices`. That port lands in task-08/task-09 when the per-service hexagonal re-organisation runs."

The deferred-port window of ADR-008 closed when the original task-08/task-09 of the Plan-A migration shipped. Every existing microservice now follows the publisher-port pattern: `IStockEventsPublisherPort` + `STOCK_EVENTS_PUBLISHER` symbol for stock, `IOrderEventsPublisherPort` + `ORDER_EVENTS_PUBLISHER` for orders. Reintroducing the pattern in `epic-04/task-07` recreates the exact state ADR-008 retired.

`epic-04/task-08` (`tmp/tasks/epic-04-inventory-stock-level-and-location/task-08-wire-new-rabbitmq-publisher.md`) immediately removes the violation — it says "The auto-init use case (task-07) gets its inline routing-key literal replaced with the constant + delegates to the publisher class instead of calling `ClientProxy.emit()` directly". But the violation lives in task-07's instructions, and an implementer who lands on task-07 in isolation (skim-reading the epic README, or executing tasks serially with PR-per-task) will write the violating code before task-08's correction lands.

Surface: `tmp/tasks/epic-04-inventory-stock-level-and-location/task-07-add-variant-created-consumer-auto-init.md` + `tmp/tasks/epic-04-inventory-stock-level-and-location/task-08-wire-new-rabbitmq-publisher.md` (cross-references that orient task-07 against the staged shape).

## Evidence

ADR-008 §"Domain code depends on a publisher port (deferred)" (`docs/adr/008-rabbitmq-via-libs-messaging.md:93-108`):

```text
### Domain code depends on a publisher port (deferred)

Today the RabbitMQ `ClientProxy` is injected directly by services
that publish (e.g. `retail-microservice/.../order-confirm.service.ts`
sends `inventory.order.confirm` via a `ClientProxy` keyed on
`MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE`). Per ADR-004
the long-term shape is:

- Domain layer defines `IMessagePublisher` (or similar).
- An adapter in `libs/messaging` (or app-side) implements it via
  `ClientProxy`.
- Domain code never imports `@nestjs/microservices`.

That port lands in task-08/task-09 when the per-service hexagonal
re-organisation runs. …
```

Offending task instructions (`tmp/tasks/epic-04-inventory-stock-level-and-location/task-07-add-variant-created-consumer-auto-init.md:54-95` — excerpted):

```ts
import { ClientProxy } from '@nestjs/microservices';
// …
@Injectable()
export class AutoInitStockLevelUseCase {
  constructor(
    @Inject(STOCK_REPOSITORY) private readonly repository: IStockRepositoryPort,
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
    @InjectPinoLogger(AutoInitStockLevelUseCase.name) private readonly logger: PinoLogger,
  ) {}
  // …
  await firstValueFrom(
    this.notificationClient.emit(
      'inventory.stock-level.initialized', // TODO(epic-04 task-08)
      { variantId, stockLocationId, eventVersion: 'v1', correlationId: correlationId ?? '' },
    ),
  );
```

`epic-04/task-08` self-acknowledgement (`tmp/tasks/epic-04-inventory-stock-level-and-location/task-08-wire-new-rabbitmq-publisher.md:20`):

```text
the auto-init use case (task-07) gets its inline routing-key literal replaced with the constant + delegates to the publisher class instead of calling `ClientProxy.emit()` directly
```

And `task-08:366`:

```text
2. The publisher port discipline — the use case no longer carries a direct `ClientProxy` injection; all RMQ emits go through `IStockEventsPublisherPort`.
```

Live publisher-port pattern in the stock module (`apps/inventory-microservice/src/modules/stock/application/ports/stock-events.publisher.port.ts:1-10`):

```ts
// (existing port surface — confirms the pattern that task-07 should follow from the start)
```

(`grep "import.*ClientProxy" apps/inventory-microservice/src/modules/stock/application/` → returns no hits in the live code; the use-case layer is `ClientProxy`-free today.)

## Why this matters

ADR-004's hexagonal layout and ADR-008's port-based publisher pattern are load-bearing for the architecture-lint rules in [ADR-017](../../../docs/adr/017-architecture-lint-via-eslint-boundaries.md). The lint rules will (or should) reject `import { ClientProxy } from '@nestjs/microservices'` inside an `application/use-cases/` directory. A task that explicitly instructs the implementer to add this import:

- Sets up the implementer for a CI failure (the boundaries rule fires on the use-case file).
- Bakes a known-violating pattern into a task that may be picked up in isolation, before task-08's correction.
- Erodes the architecture-lint promise — the lint rule's purpose is to prevent exactly this pattern from being written.

The staged "violate in task-07, fix in task-08" shape was reasonable engineering choice when the ADR's deferred window was open. It is not reasonable now that every other microservice has the publisher port in place — task-07's "intermediate state" is a regression from the live state.

## Proposed resolution

Recommend **option A**.

**Option A — Collapse `task-07` and `task-08` into one task that ships the publisher port from the start (recommended).**

Two equivalent shapes the implementer may choose between:

1. **Merge task-07 and task-08 into a single combined task** (renaming or numbering at implementer discretion). The combined task:
   - Adds `IStockEventsPublisherPort.publishStockLevelInitialized(payload)` to the existing port surface in `apps/inventory-microservice/src/modules/stock/application/ports/stock-events.publisher.port.ts`.
   - Adds the implementation method to `StockRabbitmqPublisher` (`apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts`).
   - Adds `ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED: 'inventory.stock-level.initialized'` to `libs/messaging/routing-keys.constants.ts`.
   - Adds `AutoInitStockLevelUseCase` injecting `STOCK_EVENTS_PUBLISHER` (the existing DI symbol), not `ClientProxy`.
   - Adds the `variant-created.consumer.ts` controller (task-07's other deliverable).

2. **Keep task-07 and task-08 as separate tasks, but rewrite task-07 so the use-case ships with the publisher-port injection from the start.** The routing-key constant + the publisher-port method addition move forward into task-07; task-08's remaining scope becomes "wire the rest of the publisher" (legacy RPC handler reshape, stock-event payload migration).

Either shape removes the time-window in which a use-case under `application/use-cases/` injects `ClientProxy`. Implementer picks based on PR-size preference.

**Option B — Keep the staged violation but mark it explicitly in the task body with a cite of ADR-008's "deferred" framing.**

Rejected as the recommendation. The "deferred" framing in ADR-008 was a time-of-writing concession; the deferred window has closed in the live code, and re-opening it for one task is the wrong precedent. If kept as a backstop, the task body should at minimum (a) cite ADR-008 §"Domain code depends on a publisher port (deferred)" explicitly, (b) acknowledge the deferred window has closed in the live code, and (c) cap the regression window to a single PR by requiring task-08 to land in the same PR as task-07. The simpler fix is option A.

## Scope

**In:**

- Edit `tmp/tasks/epic-04-inventory-stock-level-and-location/task-07-add-variant-created-consumer-auto-init.md` to remove the `ClientProxy` injection from `AutoInitStockLevelUseCase` and route the emit through the publisher port (option A, shape 1 or shape 2).
- Edit `tmp/tasks/epic-04-inventory-stock-level-and-location/task-08-wire-new-rabbitmq-publisher.md` to remove the parts that were moved into task-07 (or merge the entire task into task-07 if shape 1 is chosen).
- Edit `tmp/tasks/epic-04-inventory-stock-level-and-location/README.md` if the task ordering / list of tasks changes.

**Out:**

- Any change to live code in `apps/inventory-microservice/`.
- Any change to ADR-008 itself (the binding rule is correct; the task contradicts it).
- Any change to the matching epic-02 catalog publisher tasks (those already use `STOCK_EVENTS_PUBLISHER`-shape ports correctly).

## Exit criteria

- [ ] No task under `tmp/tasks/**` instructs an implementer to inject `ClientProxy` into a file under `apps/*/src/modules/*/application/`.
- [ ] `tmp/tasks/epic-04-inventory-stock-level-and-location/task-07-…md` (or its merged successor) shows `AutoInitStockLevelUseCase` injecting `STOCK_EVENTS_PUBLISHER` (the port symbol), not `ClientProxy`.
- [ ] `yarn lint` still passes (this task edits only `tmp/tasks/**/*.md`).
- [ ] `tmp/adr-verification-progress.md` ADR-008 row reflects this task's findings.
