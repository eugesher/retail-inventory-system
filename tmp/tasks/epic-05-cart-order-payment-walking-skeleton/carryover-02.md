# Carryover 02 — Cart + CartLine aggregate foundation landed

## Entry state for task-03

The retail microservice now hosts the **mutable** side of the rebuilt checkout —
the `cart` bounded-context module — as **foundation only** (domain + persistence +
repository + contracts + migration). **No use cases, publisher, controller, or
gateway exist yet**; the service boots with the `cart` module registered but still
listens on `retail_queue` with **no `@MessagePattern` / `@EventPattern`
handlers**.

### Domain model (`apps/retail-microservice/src/modules/cart/domain/`)

- **`Cart extends AggregateRoot<string | null>`** — id is a **`CHAR(36)` UUID
  generated in-app by `Cart.create(...)`** (caller-assigned; concrete from the
  moment the cart exists — *not* DB-assigned, unlike the catalog variant id).
  - `Cart.create({ customerId, currency, expiresAt? })` → new `active`, empty,
    `version 0` cart; **records `CartCreatedEvent`**.
  - `Cart.reconstitute(props)` → load path (any status/version; records nothing).
  - Getters: `customerId` (`string | null`), `currency` (immutable, validated
    `^[A-Za-z]{3}$`), `status`, `lines` (`readonly CartLine[]`), `expiresAt`,
    `version`, `isActive()`, and `total` → `{ subtotalMinor, currency }` (pure,
    Σ `unitPriceSnapshotMinor × quantity`, minor units).
  - Mutators — **each bumps `version`** (in-memory); the line mutators record a
    domain event drained via `pullDomainEvents()`; a **non-`active` cart is frozen
    (line mutators throw `CART_NOT_ACTIVE`)**:
    - `addLine({ variantId, quantity, unitPriceSnapshotMinor, currencySnapshot })`
      — **increment-existing-line** (chosen, documented): a repeat add of the same
      `variantId` increments the existing line's quantity and **preserves the
      existing price snapshot** (incoming snapshot ignored on the increment path);
      a new variant appends a new line. Records `CartLineAddedEvent` carrying the
      quantity **added in this call**.
    - `changeLineQuantity(lineId, quantity)` — sets a positive quantity; `0`
      rejected (`CART_LINE_QUANTITY_INVALID`); unknown id → `CART_LINE_NOT_FOUND`.
      Records `CartLineQuantityChangedEvent`.
    - `removeLine(lineId)` — drops the line (`CART_LINE_NOT_FOUND` if absent).
      Records `CartLineRemovedEvent`.
    - `markConverted()` / `markAbandoned()` — `active →` terminal; reject if not
      `active` (`CART_INVALID_STATE_TRANSITION`).
- **`CartLine extends Entity<number | null>`** — id is the `BIGINT` PK
  (`null` until persisted). Fields: `variantId` (positive int, **opaque** — never
  import catalog `ProductVariant`), `quantity` (positive int), `unitPriceSnapshotMinor`
  (non-negative int, minor units), `currencySnapshot` (non-empty). Snapshot fields
  are **immutable** (captured at add-time, stable while siblings mutate); only
  `quantity` changes (`changeQuantity` / `increaseQuantity`). `lineSubtotalMinor`
  getter.
- **`CartDomainException` + `CartErrorCodeEnum`** — **newly introduced** (not in
  the task's explicit file list; see Deviations). The cart context's concrete
  `DomainException` (codes: `CART_CURRENCY_INVALID`, `CART_VERSION_INVALID`,
  `CART_NOT_ACTIVE`, `CART_INVALID_STATE_TRANSITION`, `CART_LINE_NOT_FOUND`,
  `CART_LINE_QUANTITY_INVALID`, `CART_LINE_VARIANT_INVALID`,
  `CART_LINE_PRICE_INVALID`, `CART_LINE_CURRENCY_REQUIRED`). The HTTP filter that
  maps these → status codes lands with the operations (task-05).
- **Domain events** (`events/`, `DomainEvent<string>` keyed on cartId):
  `CartCreatedEvent` (customerId, currency), `CartLineAddedEvent` (variantId,
  quantity), `CartLineRemovedEvent` (lineId), `CartLineQuantityChangedEvent`
  (lineId, quantity). Mapped to the wire events by the use cases (task-05) — never
  serialized across services (ADR-011).

### Repository port (`application/ports/cart.repository.port.ts`)

`CART_REPOSITORY` symbol; `ICartRepositoryPort`:

```ts
findById(id: string): Promise<Cart | null>;
save(cart: Cart): Promise<Cart>;                                  // upsert root + lines, re-reads concrete ids
reassignCustomer(cartId: string, customerId: string): Promise<void>; // guest-promotion seam (task-05)
```

`CartTypeormRepository` is the only `@InjectRepository` site. `save` runs one
transaction: root upsert (caller-UUID PK → INSERT/version-checked UPDATE) →
**explicit line reconciliation** (delete the cart's rows not in the aggregate, then
upsert survivors + insert new) → **re-read the saved graph**. **Verified against
live MySQL** (create+line, add+change, orphan-delete on remove, reassign all
correct).

### Persistence + schema (migration `1781041255857-CreateCartTables`)

- `cart`: `id CHAR(36)` PK, `customer_id CHAR(36)` NULL, `currency CHAR(3)`,
  `status ENUM('active','abandoned','converted') DEFAULT 'active'`, `expires_at`,
  `version INT DEFAULT 0`, timestamps + **inert `deleted_at`**. FK
  `FK_CART_CUSTOMER → customer(id) ON DELETE SET NULL`. `utf8mb4_unicode_ci`.
- `cart_line`: `id BIGINT UNSIGNED` PK, `variant_id BIGINT UNSIGNED`, `quantity INT`,
  `unit_price_snapshot_minor BIGINT`, `currency_snapshot CHAR(3)`, timestamps +
  **inert `deleted_at`**. FKs `FK_CART_LINE_CART → cart(id) ON DELETE CASCADE`,
  `FK_CART_LINE_VARIANT → product_variant(id) ON DELETE RESTRICT`,
  `CHECK (quantity > 0)`, index `IDX_CART_LINE_CART`. `utf8mb4_unicode_ci`.
- **`cart.id` is a `CHAR(36)` string PK** — diverges from `BaseEntity`'s
  auto-increment int. `CartEntity` uses the `Omit<BaseEntity, 'id'>` override (the
  `StockLocationEntity` technique) + `@VersionColumn`.
- All four contexts share the one MySQL DB, so `customer_id` / `variant_id` are
  **real cross-context FKs**.

### Contracts (`libs/contracts/retail`) — placeholder `export {}` removed

- **`CartStatusEnum`** = `ACTIVE='active'` / `ABANDONED='abandoned'` /
  `CONVERTED='converted'` (a wire contract — surfaces on the view + created event).
- **`CartView`** (`id, customerId, currency, status, expiresAt, version, lines:
  CartLineView[], subtotalMinor`) + **`CartLineView`** (`id, variantId, quantity,
  unitPriceSnapshotMinor, currencySnapshot, lineSubtotalMinor`) — classes with
  `@ApiResponseProperty` (the `PriceView` pattern).
- Four wire events: `IRetailCartCreatedEvent`, `IRetailCartLineAddedEvent`,
  `IRetailCartLineRemovedEvent`, `IRetailCartLineQuantityChangedEvent` (each
  `eventVersion: 'v1'`, extends `ICorrelationPayload` + `occurredAt: string`).

### Routing keys (reserved surfaces — no producer/consumer yet)

Added to `ROUTING_KEYS` + mirrored in `MicroserviceMessagePatternEnum` (+ spec):
- `RETAIL_CART_CREATED = 'retail.cart.created'`
- `RETAIL_CART_LINE_ADDED = 'retail.cart.line-added'`
- `RETAIL_CART_LINE_REMOVED = 'retail.cart.line-removed'`
- `RETAIL_CART_LINE_QUANTITY_CHANGED = 'retail.cart.line-quantity-changed'`

The cart **command** keys (`retail.cart.create` / `.get` / line ops) are NOT added
here — task-05 adds them with the handlers.

### Module wiring

`cart.module.ts` (`infrastructure/`): `DatabaseModule.forFeature([CartEntity,
CartLineEntity])`, provides `CartTypeormRepository` + `{ provide: CART_REPOSITORY,
useExisting: CartTypeormRepository }`, exports `CART_REPOSITORY`. The module barrel
`modules/cart/index.ts` exports `cartEntities` + `CartModule`. Retail
`app.module.ts` now `DatabaseModule.forRoot(cartEntities)` + imports `CartModule`
(no longer `forRoot([])`).

## Files added / modified

**Added** (all under `apps/retail-microservice/src/modules/cart/` unless noted):
- `domain/cart.model.ts`, `cart-line.model.ts`, `cart.exception.ts`,
  `events/{cart-created,cart-line-added,cart-line-removed,cart-line-quantity-changed}.event.ts`,
  `events/index.ts`, `index.ts`, `domain/index.ts`
- `domain/spec/cart.model.spec.ts`, `cart-line.model.spec.ts`
- `application/ports/cart.repository.port.ts`, `application/ports/index.ts`
- `infrastructure/persistence/{cart,cart-line}.entity.ts`,
  `{cart,cart-line}.mapper.ts`, `cart-typeorm.repository.ts`, `index.ts`,
  `spec/cart-typeorm.repository.spec.ts`
- `infrastructure/cart.module.ts`
- `libs/contracts/retail/enums/cart-status.enum.ts` + `enums/index.ts`
- `libs/contracts/retail/dto/cart.view.ts` + `dto/index.ts`
- `libs/contracts/retail/events/{4 events}.ts` + `events/index.ts`
- `migrations/1781041255857-CreateCartTables.ts`
- `docs/implementation/05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md`

**Modified**:
- `apps/retail-microservice/src/app/app.module.ts` — `forRoot(cartEntities)` + `CartModule`.
- `libs/contracts/retail/index.ts` — dropped `export {}`, re-exports dto/enums/events.
- `libs/messaging/routing-keys.constants.ts` + `spec/routing-keys.constants.spec.ts`.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`.
- `README.md` (services table, retail section, system-diagram DB box + retail box) +
  `CLAUDE.md` (app tree, message-patterns Retail, retail module section, DB entities,
  contracts sub-areas). **CLAUDE.md is git-excluded** (`.git/info/exclude`) — edits
  are on disk but won't show in `git status`.

## Key decisions & deviations (task-03+ must respect)

- **`CartDomainException` + `CartErrorCodeEnum` introduced now** (not in the task's
  Files-to-add). Rationale: the mutators must reject typed errors that task-05 maps
  to HTTP (403/404/409); a plain `Error` would later need replacing. **It is
  cart-module-scoped** (mirrors `CatalogDomainException` / `PricingDomainException`
  per-module) — task-03's orders module should introduce its **own**
  `OrderDomainException`, not reuse this one.
- **`cart_line.deleted_at` added** (the task's example DDL omitted it). Required
  because `CartLineEntity extends BaseEntity` (TypeORM appends `deleted_at IS NULL`
  to every `find`; without the column, reads fail). Same as every `BaseEntity`
  child table (`product_variant`, etc.). Stays inert. **Apply the same to any
  `order_line` table in task-03.**
- **`CartLineEntity` has NO scalar `cart_id` column** — the owning cart is mapped
  through the `@ManyToOne` relation alone. A string-FK twin-mapping (`char(36)`
  scalar + join column on one `cart_id`) trips TypeORM's metadata validator ("does
  not support length property"); `product_variant`'s twin-mapping works only because
  its FK is numeric. The mapper sets the FK via `cart: { id: cartId }`. **task-03's
  `order_line` with a `CHAR(36)` `order_id` FK will hit the same issue — use the
  relation-only mapping.**
- **Both tables `utf8mb4_unicode_ci`** so the CHAR(36) FK collations match
  `customer` / `cart`. (The customer table is `utf8mb4_unicode_ci`.)
- **`version` semantics**: domain bumps in-memory on every mutation;
  `@VersionColumn` owns the persisted value (bumps on managed root `save()` **and**
  on `repository.update()` — confirmed `reassignCustomer` also advances it). OCC
  enforcement is deferred (ADR-028 §6). The mapper **omits `version`** (TypeORM
  owns it), like `StockLevelMapper`.
- **`Cart.create` generates the UUID in the domain** (`randomUUID` from `crypto`,
  allowed in domain — `DomainEvent` base already imports it). The create use case
  (task-05) does **not** assign the id; it just persists and re-reads.
- ADR-028 is the governing decision; no new ADR introduced.

## Known gaps / deferrals (each names its owning task)

- Cart **operations** (Create/Get/AddToCart/ChangeQty/Remove use cases), the cart
  **RabbitMQ publisher** (maps domain → wire events), the **presentation**
  `@MessagePattern` handlers + RPC exception filter, the **gateway `modules/cart/`**
  HTTP routes, the cart **command** routing keys, the catalog **price-snapshot
  port**, and **guest-cart promotion** (`reassignCustomer` use case + `claim`
  route) → **task-05**. (Doc `02`'s "Guest carts" section is the placeholder
  task-05 completes.)
- Immutable **`Order` / `OrderLine` + polymorphic `Address`** foundation → **task-03**.
- **`Payment` aggregate + `PAYMENT_GATEWAY` port + `FakePaymentGatewayAdapter`**
  (inside the orders module) → **task-04**.
- **Place Order** (cart → order snapshot, `markConverted`, authorize-on-place,
  `retail.order.placed`) → **task-06**.

## How to verify (all green as of this task)

- `yarn build` — all five apps compile.
- `yarn lint` — clean (`--max-warnings 0`).
- `yarn test:unit` — **529 pass** (was 481; +48 from the cart domain/repository specs
  and the routing-keys additions).
- **Migration round-trip** (infra up): `yarn migration:run` creates `cart` +
  `cart_line` (with `version`, FKs, `CHECK`, index); `yarn migration:revert` drops
  both (no `cart%` tables remain); `yarn migration:run` re-creates — **verified**.
- `yarn test:e2e` — full infra reload (`down -v` → up → migrate incl. CreateCartTables
  → seed) + **88 e2e pass** (10 suites). The cart tables exist but no e2e references
  them yet.
- **Boot**: `node dist/apps/retail-microservice/main.js` logs "Retail Microservice
  is listening for messages" with the `cart` module registered (no handlers).
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
