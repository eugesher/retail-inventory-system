# Carryover 01 — Legacy order model torn down; retail rebooted order-free

## Entry state for task-02

- **Four legacy order tables are dropped**: `order`, `order_product`,
  `order_status`, `order_product_status`. The drop ships as migration
  `migrations/1781035412497-DropLegacyOrderTables.ts` (run/revert/run verified —
  see *How to verify*).
- **The retail microservice boots order-free.** `apps/retail-microservice/src/app/app.module.ts`
  wires only `ConfigModule` + `LoggerModule` + `DatabaseModule.forRoot([])`. The
  entire `apps/retail-microservice/src/modules/orders/` tree is deleted. It
  listens on `retail_queue` with **no `@MessagePattern` / `@EventPattern`
  handlers**. (`main.ts` is unchanged and still boots the RMQ microservice.)
- **The gateway has no retail/order module.** `apps/api-gateway/src/modules/retail/`
  is deleted and unregistered from `app/app.module.ts` (`RetailModule` import +
  `imports[]` entry removed). The gateway exposes no order/cart routes.
- **The notification order consumer + use case are deleted.**
  `order-events.consumer.ts` and `send-order-notification.use-case.ts` (+ its
  spec) are gone, unregistered from `notifications.module.ts` and the
  `consumers/` + `use-cases/` barrels. The low-stock consumer + use case are
  untouched. `test-doubles.ts` stays (still used by the low-stock spec).
- **`libs/contracts/retail` is empty of order contracts.** All `dto/`, `events/`,
  `interfaces/`, `enums/` order files (and their barrels + the four sub-dirs) are
  deleted; `libs/contracts/retail/index.ts` is a single `export {};` placeholder.
  **Task-02 should remove the placeholder when it adds the first real
  cart/contract export.**
- **The six `retail.order.*` keys are retired** from `ROUTING_KEYS`
  (`libs/messaging/routing-keys.constants.ts`) and the mirrored
  `MicroserviceMessagePatternEnum`
  (`libs/contracts/microservices/microservice-message-pattern.enum.ts`); the
  routing-keys spec is trimmed to match. **The new `retail.cart.*` /
  `retail.order.placed` / `retail.payment.*` keys are NOT added here** — task-02
  (cart) and task-06 (place) add them with their producers.
- **The surviving `customer` table is the gateway auth aggregate** (`CHAR(36)`
  UUID PK, ADR-024). It is **not** dropped — it is the FK target the new
  `order` / `cart` tables reference in later tasks. This task drops **4** tables,
  not 5.
- **The inventory `inventory.order.confirm` stub + `INVENTORY_ORDER_CONFIRM` key
  + `IProductStockOrderConfirmPayload` contract are untouched as a reserved
  surface** (ADR-027 owns their eventual removal). The retail-side caller is the
  only thing deleted.

## Files added / modified / deleted

**Added**
- `migrations/1781035412497-DropLegacyOrderTables.ts`
- `docs/adr/028-cart-order-payment-and-address-chain.md`
- `docs/implementation/05-cart-order-payment-walking-skeleton/01-retail-rebuild-and-old-tables-dropped.md`

**Modified**
- `apps/retail-microservice/src/app/app.module.ts` — `DatabaseModule.forRoot([])`, no `OrdersModule`.
- `apps/api-gateway/src/app/app.module.ts` — `RetailModule` removed.
- `apps/notification-microservice/.../infrastructure/notifications.module.ts` — order consumer + use case unwired.
- `apps/notification-microservice/.../infrastructure/consumers/index.ts` + `.../application/use-cases/index.ts` — order barrels trimmed.
- `libs/contracts/retail/index.ts` — `export {};` placeholder.
- `libs/contracts/inventory/product-stock/product-stock-order-confirm/product-stock-order-confirm.types.ts` — **inlined** the per-line item shape (`IProductStockOrderConfirmItem`, `statusId: string`) so the kept contract no longer imports the deleted retail `IOrderProductConfirm` / `OrderProductStatusEnum`.
- `apps/inventory-microservice/.../presentation/stock.controller.ts` — **comment-only** fix on the `inventory.order.confirm` stub (it referenced the now-deleted retail adapter + superseded ADR-013 §7; repointed to ADR-027). Behavior unchanged.
- `libs/messaging/routing-keys.constants.ts` + `libs/messaging/spec/routing-keys.constants.spec.ts` — six `retail.order.*` keys retired.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts` — six `RETAIL_ORDER_*` members removed.
- `scripts/utils/test-db-seed.util.ts` — `order.sql` / `order-product.sql` removed from `seedFiles`.
- `spec/architecture-lint.spec.ts` — the "use case may not reach another app" fixture imported the deleted `retail-microservice/.../order.model`; **repointed to the catalog app's `product.model`** (a still-existing cross-app domain target) so the boundaries rule still fires.
- `test/auth.e2e-spec.ts` — the protected-route sample moved off the deleted `POST /api/order` onto `GET /api/inventory/locations` (401-without-token preserved).
- `README.md` + `CLAUDE.md` — order routes / `retail.order.*` keys / deleted module trees removed or repointed (minimal pass; full retail rewrite is task-09). The README log-walkthrough was repointed from the deleted `PUT /api/order/1/confirm` to the live `POST /api/inventory/variants/:id/stock/adjust` → `inventory.stock.low` flow (it also still named the long-deleted `ReserveStockForOrderUseCase`). **NOTE: CLAUDE.md is git-excluded (`.git/info/exclude`)** — its edits are on disk but won't show in `git status`.

**Deleted**
- `apps/retail-microservice/src/modules/orders/` (entire tree).
- `apps/api-gateway/src/modules/retail/` (entire tree).
- `apps/notification-microservice/.../consumers/order-events.consumer.ts`,
  `.../use-cases/send-order-notification.use-case.ts` (+ its spec).
- All `libs/contracts/retail/{dto,events,interfaces,enums}/` order files + barrels + the four sub-dirs.
- `scripts/seeds/order.sql`, `scripts/seeds/order-product.sql`.
- `http/order.http`.
- `test/system-api.e2e-spec.ts` + `test/__snapshots__/system-api.e2e-spec.ts.snap`,
  `test/data-source/system-api.e2e-spec.data-source.ts`, `test/data-source/index.ts`,
  `test/notification.e2e-spec.ts`.

## Key decisions & deviations

- **ADR-028 allocated** as `028` (number was free); recorded as
  `docs/adr/028-cart-order-payment-and-address-chain.md`.
- **ADR-013 marked `Superseded by ADR-028`** (status line flipped + a one-line
  pointer added; the only edit an accepted ADR may receive). The ADR index table
  row was updated to match and a row for ADR-028 added.
- **Payment lives inside the `orders/` module** (not a separate `payment/`
  module) — recorded in ADR-028 §4. Task-04 must put `Payment` + `PAYMENT_GATEWAY`
  + `FakePaymentGatewayAdapter` inside the retail orders module.
- **Customer cart/order routes are owner-checked** (authenticated + use-case
  ownership comparison), **not** gated by a `customer:own-orders:read` permission
  code — ADR-024 fixes customer tokens carry no `permissions` claim (ADR-028 §7).
  Staff overrides use `order:read` (existing) + `order:capture` (new, added in
  the read/capture task).
- **`system-api.e2e-spec.ts` was DELETED, not trimmed.** Its only content was the
  `Order` describe block; removing it left no assertions, so the whole spec + its
  `.snap` + its data-source helper were removed (the task permitted this). Retail
  + inventory + gateway still boot together under `auth.e2e-spec.ts`, so the
  "trimmed services boot clean" coverage is preserved.
- **`notification.e2e-spec.ts` was DELETED** (it published a synthetic
  `retail.order.created` and asserted the notifier fired). **Task-08 must re-add
  a notification e2e against `retail.order.placed`.**
- **`auth.e2e-spec.ts` was repointed** to `GET /api/inventory/locations`
  (`inventory:read`-gated) for the 401-without-token sample.
- **Kept-contract de-coupling (deviation worth noting):** the task's *Files to
  delete* removed retail `IOrderProductConfirm` + `OrderProductStatusEnum`, but
  the kept inventory `IProductStockOrderConfirmPayload` transitively imported
  both. The clean cut was to **inline** the line-item shape into the inventory
  contract (`statusId` is now `string`). No behavior change — the stub never
  reads the payload.

## Known gaps / deferrals (each names its owning task)

- Cart foundation (`Cart` + `CartLine`, tables, `retail.cart.*` keys) → **task-02**.
- Order/OrderLine/Address foundation → **task-03**.
- Payment aggregate + `PAYMENT_GATEWAY` port + fake adapter (inside `orders/`) → **task-04**.
- Cart operations + guest promotion → **task-05**.
- Place Order + authorize-on-place + `retail.order.placed` event → **task-06**.
- Capture + Get + List + `order:capture` permission + seed → **task-07**.
- Notification re-point (re-add the deleted notification e2e against `retail.order.placed`) → **task-08**.
- README / CLAUDE full retail rewrite + lint fixtures + new `http/*.http` files → **task-09**.
- The inventory `inventory.order.confirm` seam removal is owned by the
  **inventory-reservation capability** (ADR-027), **not** this epic.

## How to verify

All green as of this task:

- `yarn build` — all five apps compile.
- `yarn lint` — clean (`--max-warnings 0`).
- `yarn test:unit` — 481 specs pass (incl. the trimmed routing-keys spec and the
  repointed `architecture-lint` fixture).
- **Migration round-trip** (infra up): `yarn migration:run` drops the four order
  tables (`SHOW TABLES` confirms none remain); `yarn migration:revert` recreates
  all four + re-seeds the two-value status rows (`order_product` comes back with
  only `FK_ORDER_PRODUCT_ORDER`, `order` without `customer_id`); `yarn migration:run`
  drops them again — **verified clean**.
- `yarn test:e2e` — full infra reload (`down -v` → up → migrate → seed) + all e2e
  specs; the seed runs without `order.sql` / `order-product.sql`.
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- Dangling-reference scan clean (only benign survivors: `MicroserviceClientRetailModule`
  — the reserved `retail_queue` transport client; `RETAIL_ORDER_KEY_VERSION` /
  `retailOrderPrefix` in `libs/cache/cache-keys.ts` — reserved cache builders per
  ADR-022; both reused by the rebuilt order aggregate).
- Boot check: `docker compose up -d && yarn migration:run && yarn start:dev` boots
  retail order-free (listens on `retail_queue`, no handlers).
