# Carryover 08 — Notification consumer re-pointed to `retail.order.placed`

## Entry state for task-09

The order-placed notification leg is **whole again**. The notification microservice
now consumes **two** cross-service events on `notification_events`:

- `inventory.stock.low` → `InventoryEventsConsumer` → `SendLowStockAlertUseCase` (untouched).
- **`retail.order.placed` → `OrderEventsConsumer` → `SendOrderNotificationUseCase`** (re-created this task).

The full chain — gateway → retail Place Order → `retail.order.placed` (best-effort
post-commit emit) → notification fan-out — is live and dispatches via the default
`LogNotifierAdapter`. No schema change, no new routing key (`RETAIL_ORDER_PLACED`
already existed from task-06), no new gateway endpoint, no `.http` change.

### Re-created files (modelled on the low-stock leg)

- **`SendOrderNotificationUseCase`**
  (`apps/notification-microservice/.../application/use-cases/send-order-notification.use-case.ts`)
  — consumes `IRetailOrderPlacedEvent`; builds a `Notification` (`channel: LOG`,
  `recipient: 'order:<orderId>'`, subject/body citing `orderNumber` +
  `grandTotalMinor` + `currency` + `lineCount`, `metadata` carrying the event fields +
  `occurredAt`); logs `correlationId` inline; calls `NOTIFIER.send(...)`. Built fresh
  against the new thin-header payload — **not** the old `IRetailOrderCreatedEvent`
  shape (which carried `status` + `products[]`). Body singularizes "line"/"lines" by
  `lineCount`; a `null` `customerId` (tombstoned order) passes straight to metadata.
- **`OrderEventsConsumer`**
  (`.../infrastructure/consumers/order-events.consumer.ts`) —
  `@EventPattern(ROUTING_KEYS.RETAIL_ORDER_PLACED)` →
  `SendOrderNotificationUseCase.execute(event)`.

### Registration / barrels

- `notifications.module.ts` — `OrderEventsConsumer` added to `controllers[]`,
  `SendOrderNotificationUseCase` added to `providers[]` (the retirement comment
  replaced with a two-consumer description).
- `infrastructure/consumers/index.ts` + `application/use-cases/index.ts` — both export
  the new file.
- `spec/test-doubles.ts` was **reused as-is** (`InMemoryNotifier` + `FakeLogger`) — the
  order spec needed no new double.

### Tests

- **Unit** `spec/send-order-notification.use-case.spec.ts` — 4 cases (metadata/subject/
  body carry orderNumber+id+totals; line singularization; null customerId; correlationId
  logged). `yarn test:unit` now **653 pass** (was 649, +4).
- **E2E** `test/notification.e2e-spec.ts` — **re-added** (it was deleted in task-01).
  Boots the notification microservice on `notification_events`, spies
  `LogNotifierAdapter.prototype.send` (via `jest.spyOn`, not `jest.fn()` — the real body
  still runs), publishes a synthetic `retail.order.placed` (`IRetailOrderPlacedEvent`)
  through a `ClientProxy`, and asserts `send` fired with the order metadata. `yarn
  test:e2e` now **114 pass / 15 suites** (was 113/14, +1 suite).

## Files added / modified / deleted

**Added**
- `apps/notification-microservice/.../application/use-cases/send-order-notification.use-case.ts`
  (+ `spec/send-order-notification.use-case.spec.ts`)
- `apps/notification-microservice/.../infrastructure/consumers/order-events.consumer.ts`
- `test/notification.e2e-spec.ts`
- `docs/implementation/05-cart-order-payment-walking-skeleton/09-routing-keys-retired-and-added.md`

**Modified**
- `apps/notification-microservice/.../infrastructure/notifications.module.ts` — consumer + use case registered.
- `apps/notification-microservice/.../infrastructure/consumers/index.ts`,
  `.../application/use-cases/index.ts` — barrels extended.
- `README.md` — services table (notification fans out two events now), the per-module
  tree (both use-cases + both consumers), and the adapter blurb.
- `CLAUDE.md` — notification module bullet + the "Cross-service events" operational
  note (the `retail.order.placed` consumer is live). **NOTE: CLAUDE.md is git-excluded
  (`.git/info/exclude`)** — its edits are on disk but won't show in `git status`.

**Deleted** — none.

## Key decisions & deviations

- **`recipient: 'order:<orderId>'`** (parallels the low-stock `'ops:inventory'`) — a
  placeholder routing handle, not a real customer address; the `LogNotifierAdapter` only
  logs. A real email/webhook adapter would resolve the customer contact later.
- **`cart-to-order-walking-skeleton.e2e-spec.ts` was NOT changed.** It already "shows
  the notification leg firing end-to-end" by spying the retail-side
  `OrderRabbitmqPublisher.publishOrderPlaced` (the producing side of the leg). It does
  not boot the notification microservice — the dedicated `notification.e2e` proves the
  consuming side in isolation. The task's *Files to modify* did not list it.
- **Metadata mirrors the low-stock shape** — omits `correlationId` + `eventVersion`,
  includes the business fields + `occurredAt`. `correlationId` is logged, not in metadata.

## Known gaps / deferrals (each names its owning task)

- **Example-cart seed, doc `10`, README/CLAUDE full final pass, architecture-lint
  fixtures, final self-containment grep** → **task-09** (the last task in this epic).
- The two reserved payment events (`retail.payment.authorized`/`.captured`) + the four
  `retail.cart.*` events stay reserved surfaces on `retail_queue` (no consumer) — a
  later audit/fulfillment capability, not this epic.
- Email/webhook `NOTIFIER` adapters remain scaffolds (ADR-011) — a later delivery capability.

## How to verify (all green as of this task)

- `yarn lint` — clean (`--max-warnings 0`).
- `yarn test:unit` — **653 pass** (89 suites).
- `yarn test:e2e` (infra reload → migrate → seed → run) — **114 pass / 15 suites**;
  `notification.e2e` green, `cart-to-order-walking-skeleton` shows
  `publishOrderPlaced` firing.
- Focused notification e2e (infra already up): `yarn test:e2e:run --testPathPattern notification`.
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
