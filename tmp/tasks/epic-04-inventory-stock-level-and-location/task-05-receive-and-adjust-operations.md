---
epic: epic-04
task_number: 5
title: Receive Stock + Adjust Stock operations, events, gateway POST endpoints
depends_on: [1, 2, 3, 4]
doc_deliverable: docs/implementation/04-inventory-stock-level-and-location/06-receive-and-adjust-use-cases.md
adr_deliverable: none
---

# Task 05 — Receive Stock + Adjust Stock operations, events, gateway POST endpoints

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-023** (write paths invalidate the cache **only** via
`stockCache.withInvalidation(work, resolveItems, opts)` — the transaction body is
`work`, `resolveItems(result)` yields `{ variantId, stockLocationId }[]`, the
prefix delete runs post-commit), **ADR-002 / ADR-016** (invalidate after commit,
never before; cache errors are warn-and-swallow), **ADR-010 / ADR-024**
(`@RequiresPermission(PermissionCodeEnum.INVENTORY_ADJUST)` gates both writes;
customer tokens carry no `permissions`, so these are staff-only by construction),
**ADR-012** §low-stock (the threshold is the constant
`INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`, not env/DB), **ADR-011** (cross-service
wire events are plain `ICorrelationPayload` interfaces; log `correlationId` inline
in handlers), **ADR-004 / ADR-017** (use cases stay transport/ORM-free;
transactional work goes through `ITransactionPort`).

## Goal

Ship the two Stage-1 write operations on the new model and expose them over HTTP:
**Receive Stock** (`quantityOnHand += n`) and **Adjust Stock** (signed delta with a
mandatory `reasonCode`, rejecting any result below zero). Both route their write
through `withInvalidation` so the cached availability is invalidated post-commit,
emit their reserved-surface events (`inventory.stock.received` /
`inventory.stock.adjusted`), and lazy-init a missing `StockLevel`. Adjust also
re-fires the preserved `inventory.stock.low` event when the post-commit on-hand
falls at or below the threshold — adapted to source from the new
`StockLevel.quantityOnHand`.

## Entry state assumed

- task-01 → task-04 carryovers present. The new model, read RPCs, cache `v2`
  (`withInvalidation` available, invalidate items `{ variantId, stockLocationId }`),
  gateway read endpoints + `http/inventory.http` (read), the stock-level seed, and
  the auto-init consumer are all live. The inventory `StockModule` imports both the
  inventory + notification client modules; `StockRabbitmqPublisher` injects both
  and already emits `inventory.stock.low` (notification) +
  `inventory.stock-level.initialized` (inventory queue).
- `StockLevel.changeOnHand(delta)` enforces a non-negative result + bumps
  `version`; `StockLevel.initialAt(...)` exists. `IStockRepositoryPort` has
  `findStockLevel` / `saveStockLevel` / `findLocation`. `ITransactionPort`
  (`TRANSACTION_PORT`) + `TypeormTransactionAdapter` are available for atomic
  write-then-invalidate.
- `INVENTORY_DEFAULT_STOCK_LOCATION = 'default-warehouse'` and
  `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD = 5` live in
  `libs/contracts/inventory/inventory.constants.ts`.
- The existing `inventory.stock.low` wire contract is
  `libs/contracts/inventory/events/stock-low.event.ts`
  (`IInventoryStockLowEvent`), consumed by the notification service's
  `InventoryEventsConsumer` → `SendLowStockAlertUseCase`.

## Scope

**In**
- `ReceiveStockUseCase` + `AdjustStockUseCase` (+ specs); their reserved-surface
  events + routing keys + publisher emits.
- The low-stock emission adapted to the new model (post-commit, threshold).
- Reshape `IInventoryStockLowEvent` to the new keys + update the notification
  consumer's mapping (small cross-service edit — see below).
- Gateway POST endpoints `…/stock/receive` + `…/stock/adjust` (+ DTOs, adapter
  methods, use cases, new RPCs).
- `http/inventory.http` write requests; the two named e2e specs.
- Doc `06`.

**Out**
- Reservation, allocation, commit-sale, cancel, restock-from-return, transfer, and
  `StockMovement` persistence — all owned by later capabilities. **No
  `StockMovement` row is written**; `reasonCode` is carried in the request +
  `inventory.stock.adjusted` payload + logs only.
- Concurrent-oversell tests (land with the reservation capability that enforces
  the `version` token).

## Use cases (inventory microservice)

`ReceiveStockUseCase` (`apps/.../stock/application/use-cases/receive-stock.use-case.ts`):
- Input: `{ variantId: number; stockLocationId?: string; quantity: number;
  actorId?: string; correlationId?: string }`. Default `stockLocationId` →
  `INVENTORY_DEFAULT_STOCK_LOCATION`.
- Preconditions: `quantity` is a positive integer (reject otherwise); the location
  exists **and is active** (`repo.findLocation`); else reject.
- Effect (inside `withInvalidation` → a transaction via `TRANSACTION_PORT`):
  find-or-`initialAt` the `StockLevel`, `changeOnHand(+quantity)`, `saveStockLevel`.
  `resolveItems(result)` → `[{ variantId, stockLocationId }]`.
- Post-commit: emit `inventory.stock.received`
  `{ variantId, stockLocationId, quantityDelta (positive), newOnHand, actorId,
  eventVersion: 'v1', correlationId }`. (Receive never lowers on-hand, so no
  low-stock check.)
- Returns the updated `StockLevelView` (single location).

`AdjustStockUseCase` (`apps/.../stock/application/use-cases/adjust-stock.use-case.ts`):
- Input: `{ variantId: number; stockLocationId?: string; quantityDelta: number;
  reasonCode: string; actorId?: string; correlationId?: string }`. Default
  location as above.
- Preconditions: `quantityDelta` is a non-zero integer; **`reasonCode` is
  mandatory and non-empty** (reject otherwise); the location exists + is active.
- Effect (inside `withInvalidation`): find-or-`initialAt`, `changeOnHand(delta)`
  — which **rejects a result below zero** (surfaced as a `409` at the gateway) —
  `saveStockLevel`.
- Post-commit: emit `inventory.stock.adjusted`
  `{ variantId, stockLocationId, quantityDelta (signed), reasonCode, newOnHand,
  actorId, eventVersion: 'v1', correlationId }`; then, if `newOnHand ≤
  INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`, emit `inventory.stock.low`.
- Returns the updated `StockLevelView`.

> Map the domain "result below zero" rejection to a typed error the gateway turns
> into **`409 Conflict`** (mirror how the catalog/pricing presentation layers map
> domain rejections). The e2e asserts the `409` on `Adjust -100`.

## Events, routing keys, publisher

- New domain events `StockReceivedEvent`, `StockAdjustedEvent`
  (`apps/.../stock/domain/events/`), barrelled.
- New wire contracts in `libs/contracts/inventory/events/`:
  - `IInventoryStockReceivedEvent extends ICorrelationPayload`:
    `{ variantId, stockLocationId, quantityDelta, newOnHand, actorId?,
    eventVersion: 'v1', occurredAt }`.
  - `IInventoryStockAdjustedEvent extends ICorrelationPayload`:
    `{ variantId, stockLocationId, quantityDelta, reasonCode, newOnHand, actorId?,
    eventVersion: 'v1', occurredAt }`.
- New routing keys: `INVENTORY_STOCK_RECEIVED: 'inventory.stock.received'`,
  `INVENTORY_STOCK_ADJUSTED: 'inventory.stock.adjusted'` (+ legacy enum + spec).
- Extend `IStockEventsPublisherPort` + `StockRabbitmqPublisher`:
  `publishStockReceived` / `publishStockAdjusted` emit onto **`inventory_queue`**
  (the `INVENTORY_MICROSERVICE` client — reserved surfaces, no cross-service
  consumer yet). `inventory.stock.low` keeps going to `notification_events`.

### Low-stock event reshape (cross-service edit)

The new model keys on `variantId` / `stockLocationId`, so reshape
`IInventoryStockLowEvent` from `{ productId, storageId, quantity, threshold,
occurredAt, correlationId }` to `{ variantId, stockLocationId, quantity,
threshold, eventVersion: 'v1', occurredAt, correlationId }`. Update the
notification side that consumes it:
`apps/notification-microservice/.../consumers/inventory-events.consumer.ts` and
`SendLowStockAlertUseCase` — adjust the field references (the alert message text
is the only behaviour; keep it). This is a deliberate, contained cross-service
contract update (the start-from-scratch latitude applies); the event's *purpose*
and threshold semantics are unchanged, matching the epic's "preserved" intent.
Update the inventory `StockRabbitmqPublisher.publishStockLow` mapping + the
notification e2e (`test/notification.e2e-spec.ts`) if it asserts the old field
names.

## Gateway POST endpoints

Extend the rebuilt gateway `modules/inventory/`:
- `POST /api/inventory/variants/:variantId/stock/receive` — body
  `{ stockLocationId?: string; quantity: number }`,
  `@RequiresPermission(PermissionCodeEnum.INVENTORY_ADJUST)`, `@ApiBearerAuth()`.
- `POST /api/inventory/variants/:variantId/stock/adjust` — body
  `{ stockLocationId?: string; quantityDelta: number; reasonCode: string }`, same
  gate.
- Add request DTOs (class-validator: `quantity` positive int; `quantityDelta`
  non-zero int; `reasonCode` non-empty string; `stockLocationId` optional string).
- Extend `IInventoryGatewayPort` + the adapter with `receiveStock` / `adjustStock`
  calling new RPCs `inventory.stock-level.receive` /
  `inventory.stock-level.adjust` (add these routing keys + inventory
  `@MessagePattern` handlers; mirror in the legacy enum + spec). Both return the
  updated `StockLevelView`.
- Surface the domain below-zero rejection as `409` (a typed RPC exception →
  gateway HTTP mapping).

## `http/inventory.http` (extend)

Append (after the read requests from task-03):
- `# @name receiveStock` — `POST {{baseUrl}}/inventory/variants/1/stock/receive`
  with `Authorization: Bearer {{accessToken}}` and a JSON body
  `{ "quantity": 50 }` (omitting `stockLocationId` targets `default-warehouse` —
  document this in the header).
- `# @name adjustStock` — `POST {{baseUrl}}/inventory/variants/1/stock/adjust`
  body `{ "quantityDelta": -3, "reasonCode": "damaged" }`.
- `# @name adjustStockBelowZero` — `POST …/adjust` body
  `{ "quantityDelta": -100000, "reasonCode": "damaged" }` documenting the expected
  `409`.

Use the `warehouse-staff` (or `admin`) login in `# Prereqs:` to obtain the
bearer token (the writes need `inventory:adjust`). No `tmp/`/"epic"/"task" strings.

## Files to add

- `apps/.../stock/application/use-cases/receive-stock.use-case.ts` (+ `spec/`)
- `apps/.../stock/application/use-cases/adjust-stock.use-case.ts` (+ `spec/`)
- `apps/.../stock/domain/events/stock-received.event.ts`
- `apps/.../stock/domain/events/stock-adjusted.event.ts`
- `libs/contracts/inventory/events/stock-received.event.ts`
- `libs/contracts/inventory/events/stock-adjusted.event.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/receive-stock.use-case.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/adjust-stock.use-case.ts`
- `apps/api-gateway/src/modules/inventory/presentation/dto/receive-stock.dto.ts`
- `apps/api-gateway/src/modules/inventory/presentation/dto/adjust-stock.dto.ts`
- `test/inventory-receive-and-adjust.e2e-spec.ts`
- `test/inventory-cache.e2e-spec.ts`
- `docs/implementation/04-inventory-stock-level-and-location/06-receive-and-adjust-use-cases.md`

## Files to modify

- `apps/.../stock/domain/events/index.ts`;
  `apps/.../stock/application/use-cases/index.ts`;
  `apps/.../stock/application/ports/stock-events.publisher.port.ts`;
  `apps/.../stock/infrastructure/messaging/stock-rabbitmq.publisher.ts`;
  `apps/.../stock/presentation/stock.controller.ts` (add receive/adjust
  `@MessagePattern` handlers); `apps/.../stock/infrastructure/stock.module.ts`
  (register the two use cases).
- `libs/contracts/inventory/events/index.ts`;
  `libs/contracts/inventory/events/stock-low.event.ts` (reshape);
  `libs/messaging/routing-keys.constants.ts` (+ spec);
  `libs/contracts/microservices/microservice-message-pattern.enum.ts`.
- `apps/notification-microservice/.../consumers/inventory-events.consumer.ts` +
  `…/application/use-cases/send-low-stock-alert.use-case.ts` (field renames).
- Gateway `inventory.module.ts`, the port + adapter, the controller (add the two
  POST routes), `presentation/dto/index.ts`,
  `application/use-cases/index.ts`.
- `http/inventory.http` (append the write requests).
- `test/notification.e2e-spec.ts` — only if it asserts the old stock-low field
  names.

## Files to delete

None.

## Tests

- **Unit:**
  - `receive-stock.use-case.spec.ts` — happy path (`onHand += n`, returns the
    view); non-positive quantity rejected; location-must-be-active; lazy-init when
    no `StockLevel` exists; the write is routed through `withInvalidation` and
    `resolveItems` yields `{ variantId, stockLocationId }`; `inventory.stock.received`
    emitted post-commit.
  - `adjust-stock.use-case.spec.ts` — signed delta; **`reasonCode` mandatory**;
    a result that would go below zero is rejected (no save, no event); cache
    invalidation routed through `withInvalidation`; `inventory.stock.adjusted`
    emitted; `inventory.stock.low` emitted when `newOnHand ≤ threshold` and **not**
    emitted above it.
- **E2E** `test/inventory-receive-and-adjust.e2e-spec.ts` (the epic's named spec):
  1. Create a Variant via the catalog flow.
  2. Auto-init (task-04) yields `StockLevel = 0` at `default-warehouse` — assert
     via `GET /api/inventory/variants/:id/stock` (poll for the async consumer).
  3. Admin Receives 50 → `quantityOnHand = 50`, `available = 50`.
  4. Admin Adjusts `-3` (reason `damaged`) → `quantityOnHand = 47`, `available = 47`.
  5. Public `GET …/stock` returns 47 (cache miss then hit).
  6. Admin `Adjust -100` (or below available) → **`409`** (would push below zero).
  7. Receive/Adjust without `inventory:adjust` (e.g. a customer token or
     unprivileged staff) → `403` (proves the gate).
- **E2E** `test/inventory-cache.e2e-spec.ts` (the epic's named spec): same setup;
  after a Receive, the next public `GET …/stock` returns the post-commit value
  (proves invalidation runs **post-commit** per ADR-023 — prime the cache, receive,
  then confirm the read reflects the new figure).

## Doc deliverable

`06-receive-and-adjust-use-cases.md` — the two write operations: happy paths +
invariants (positive receive; signed adjust; mandatory `reasonCode`; non-negative
result); the post-commit `withInvalidation` flow (work → commit → prefix delete,
ADR-023); lazy-init of a missing `StockLevel`; the reserved-surface
`inventory.stock.received` / `inventory.stock.adjusted` events; the preserved
`inventory.stock.low` event re-sourced from `StockLevel.quantityOnHand` and its
reshaped payload; the staff-only `inventory:adjust` gate. State explicitly that
**`StockMovement` persistence is deferred** to the later inventory-reservation /
audit-log capabilities, with `reasonCode` carried in the event + logs until then.
Cross-link `docs/adr/023-…md`, `docs/adr/024-…md`, and
`05-auto-init-on-variant-created.md`.

## Carryover to read

`carryover-01.md` … `carryover-04.md`.

## Carryover to produce

Write `carryover-05.md`. Capture: the Receive/Adjust use-case contracts +
invariants; the new events + routing keys (`inventory.stock.received` /
`.adjusted`) + the receive/adjust RPC keys; the reshaped `IInventoryStockLowEvent`
+ the notification-side edit; the gateway POST routes + their `inventory:adjust`
gate + the `409` below-zero mapping; the `http/inventory.http` write request names.
Note the only remaining work is task-06 (README/CLAUDE full pass, doc `08`,
architecture-lint fixture re-verify, final grep) and the explicit deferral of
`StockMovement` / reservation to later capabilities. List the verify commands,
including the full receive→adjust→409 `http/inventory.http` sequence.

## Exit criteria

- [ ] `POST …/stock/receive` and `POST …/stock/adjust` work end-to-end, gated by
      `inventory:adjust`; omitting `stockLocationId` targets `default-warehouse`.
- [ ] Receive raises `quantityOnHand`; Adjust applies a signed delta with a
      mandatory `reasonCode`; an adjust that would go below zero returns `409`.
- [ ] Both writes invalidate the cached availability **post-commit** via
      `withInvalidation`; the public read reflects the new figure
      (`test/inventory-cache.e2e-spec.ts` green).
- [ ] `inventory.stock.received` / `inventory.stock.adjusted` are emitted;
      `inventory.stock.low` fires on a post-commit on-hand at/below the threshold,
      with the notification consumer green on the reshaped payload.
- [ ] `test/inventory-receive-and-adjust.e2e-spec.ts` (auto-init → receive 50 →
      adjust −3 → read 47 → adjust −100 → 409 → 403 without the permission) is
      green; the unit specs are green.
- [ ] Every `http/inventory.http` request (read + write) executes.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `yarn test:e2e` passes.
- [ ] `06-receive-and-adjust-use-cases.md` is written.
- [ ] The self-containment grep is clean.
- [ ] `carryover-05.md` is written.
