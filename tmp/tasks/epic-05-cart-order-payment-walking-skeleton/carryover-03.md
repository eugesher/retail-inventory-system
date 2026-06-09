# Carryover 03 — Order + OrderLine + polymorphic Address foundation landed

## Entry state for task-04

The retail microservice now hosts **both sides** of the rebuilt checkout: the
mutable `cart` module (task-02) **and** the new immutable `orders` module — the
`Order` aggregate root + its `OrderLine` children + the polymorphic `Address`
aggregate, as **foundation only** (domain + persistence + repositories + contracts +
migration). **No use cases, publisher, controller, `PAYMENT_GATEWAY`, or gateway
exist yet**; the service boots with the `orders` module registered but still listens
on `retail_queue` with **no `@MessagePattern` / `@EventPattern` handlers**.

### Domain model (`apps/retail-microservice/src/modules/orders/domain/`)

- **`Order extends AggregateRoot<number | null>`** — id is the **DB-assigned BIGINT**
  (null until persisted), unlike the cart's in-app UUID.
  - `Order.place({ orderNumber, customerId, currency, lines, billingAddressId,
    shippingAddressId, sourceCartId, placedAt })` → validates ≥1 line + currency,
    **derives the totals from the already-snapshotted lines**, opens
    `status=PENDING` / `paymentStatus=NONE` / `fulfillmentStatus=UNFULFILLED` at
    `version 0`. **Records no domain event** (the `retail.order.placed` event is the
    place use case's job — task-06). Lines are passed in already built (`OrderLine`
    instances); `place` fetches nothing.
  - `Order.reconstitute(props)` → load path; re-asserts the total invariant.
  - **Three orthogonal status axes** (Q4 / ADR-028 §2): `status`, `paymentStatus`,
    `fulfillmentStatus` evolve independently. Only the **payment axis** has mutators
    here: `markPaymentAuthorized()` (`none→authorized`) / `markPaymentCaptured()`
    (`authorized→captured`), each rejects an invalid start (`OrderDomainException`)
    and **bumps `version`**. **No ship/deliver/cancel mutators** (deliberately — dead
    code until those capabilities land).
  - **Total invariant** (asserted in the constructor + spec):
    `subtotalMinor = Σ line.lineTotalMinor` and `grandTotalMinor = subtotal + tax +
    shipping − discount`. In this capability tax/discount/shipping = **0**, so
    `grandTotal = subtotal = Σ lineTotal`. All money is non-negative integer minor
    units.
  - Getters: `orderNumber`, `customerId` (`string|null`), `currency` (immutable),
    the three statuses, `lines` (`readonly OrderLine[]`), the five money totals,
    `billingAddressId`/`shippingAddressId`/`sourceCartId` (`string|null`),
    `placedAt`, `version`.
- **`OrderLine extends Entity<number | null>`** — id is the BIGINT PK (null until
  persisted). Fields: `variantId` (positive int, **opaque** — never import catalog
  `ProductVariant`), `sku`, `nameSnapshot`, `quantity`, `unitPriceMinor`,
  `taxAmountMinor`, `discountAmountMinor`, `lineTotalMinor`, `status`
  (`OrderLineStatusEnum`, default `ALLOCATED`). **Fully immutable** — all fields
  `readonly` **and `Object.freeze`-d at construction** (runtime immutability; the
  spec asserts a write to `sku`/`nameSnapshot`/`unitPriceMinor` throws).
  `lineTotalMinor = unitPriceMinor × quantity + tax − discount` — derived when
  omitted, asserted when supplied. **Important: `OrderLine extends Entity`, not
  `AggregateRoot`, so freezing is safe — do NOT freeze `Order`/`Address` (their
  `AggregateRoot.pullDomainEvents()` reassigns `_domainEvents`).**
- **`Address extends AggregateRoot<string | null>`** — id is a **`CHAR(36)` UUID
  generated in-app** by `Address.forOrder(...)` (caller-assigned, like the cart id).
  - `Address.forOrder({ orderId, recipientName, line1, line2?, city, region,
    postalCode, country, phone? })` → sets `ownerType=ORDER`, `ownerId=orderId`,
    generates the UUID. (`orderId` is typed **`string`** — the place use case
    stringifies the numeric order id.)
  - `Address.reconstitute(props)` → load path.
  - Invariants: `recipientName`/`line1`/`city`/`region`/`postalCode` non-empty;
    `country` **upper-cased then `^[A-Z]{2}$`** (`us→US`, rejects `USA`/`u`);
    `ownerType ∈ AddressOwnerTypeEnum`. `line2`/`phone` nullable.
- **`OrderDomainException` + `OrderErrorCodeEnum`** — **newly introduced** (the orders
  context's concrete `DomainException`, one-per-module convention). **Covers order +
  order-line + address invariants** (codes prefixed `ORDER_*` / `ORDER_LINE_*` /
  `ADDRESS_*`) — task-04 (Payment, in this same module) should **reuse this same
  exception**, not introduce a separate one. The HTTP filter that maps these → status
  codes lands with the operations (task-05/06/07).

### Repository ports (`application/ports/`)

`ORDER_REPOSITORY` symbol; `IOrderRepositoryPort`:

```ts
findById(id: number): Promise<Order | null>;
findBySourceCartId(cartId: string): Promise<Order | null>;   // repeat-place idempotency (task-06)
save(order: Order): Promise<Order>;                          // upsert root+lines; finalizes order_number; re-reads
listByCustomer(customerId: string, page: IOrderPageRequest): Promise<IOrderPage>; // List My Orders (task-07)
nextOrderNumber(): Promise<string>;                          // non-binding preview (see below)
```

`ADDRESS_REPOSITORY` symbol; `IAddressRepositoryPort`:

```ts
save(address: Address): Promise<Address>;
findById(id: string): Promise<Address | null>;
findByOwner(ownerType: AddressOwnerTypeEnum, ownerId: string): Promise<Address[]>;
```

> **DEVIATION (must respect):** the task suggested `IPage`/`IPageRequest` from
> `@retail-inventory-system/common`, but the **boundaries lint forbids
> `application-port` → `lib-common`** (ADR-017 — verified: it errors). So pagination
> is declared **locally in the port** as `IOrderPageRequest` + `IOrderPage` (the same
> precedent the catalog port's `IProductPage` follows). Don't re-add the lib-common
> import.

`OrderTypeormRepository` + `AddressTypeormRepository` are the only `@InjectRepository`
sites for the module; both re-read the saved graph for concrete ids.

### `order_number` derivation (strategy chosen)

**Finalized inside `OrderTypeormRepository.save`, derived from the order's real
generated id** (the "re-read then finalize a derived field" idiom). On a **new** order
(`id===null`): insert with a guaranteed-unique provisional token
(`TMP-<16 hex>`, 20 chars) → read the generated id → derive
`ORD-${placedAt.getUTCFullYear()}-${String(id).padStart(8,'0')}` → `UPDATE` →
insert lines → re-read. On a **re-save** (`id!==null`, e.g. payment mutation):
`order_number` is immutable, the root update **omits** it. `nextOrderNumber()` is a
**non-binding `MAX(id)`-based preview** (the binding value always comes from `save`).
Uniqueness backed by `UC_ORDER_NUMBER` UNIQUE + by construction. **Verified live
against MySQL: a fresh order got `ORD-2026-00000001` from id=1.**

> **NOTE on `version`:** the mapper omits `version` (TypeORM `@VersionColumn` owns
> it). A fresh order reads back at persisted `version=2` (INSERT→1, order_number
> UPDATE→2), not the domain's `0` — expected, the same split cart documented.

### Persistence + schema (migration `1781101255857-CreateOrderLineAddressTables`)

Created in FK order **address → order → order_line**; `down` drops the reverse.

- `address`: `id CHAR(36)` PK, `owner_type ENUM('customer','order')`,
  `owner_id VARCHAR(36)`, `recipient_name`/`line1`/`line2?`/`city`/`region`/
  `postal_code`/`country CHAR(2)`/`phone?`, timestamps + **inert `deleted_at`**.
  Index `IDX_ADDRESS_OWNER (owner_type, owner_id)`. `utf8mb4_unicode_ci`.
- `order`: `id BIGINT UNSIGNED` PK, `order_number VARCHAR(20)` **UNIQUE
  (`UC_ORDER_NUMBER`)**, `customer_id CHAR(36)` **NULL** (tombstone), `currency
  CHAR(3)`, **three status ENUM columns** (`status`/`payment_status`/
  `fulfillment_status`), five `BIGINT` money totals (tax/discount/shipping DEFAULT 0),
  `billing_address_id`/`shipping_address_id`/`source_cart_id CHAR(36)` NULL,
  `placed_at`, `version INT DEFAULT 0`, timestamps + **inert `deleted_at`**. FKs:
  `FK_ORDER_CUSTOMER→customer(id) ON DELETE SET NULL`, `FK_ORDER_BILLING_ADDRESS`/
  `FK_ORDER_SHIPPING_ADDRESS→address(id)`, `FK_ORDER_SOURCE_CART→cart(id) ON DELETE
  SET NULL`. Index `IDX_ORDER_CUSTOMER_PLACED (customer_id, placed_at)`.
  `utf8mb4_unicode_ci`.
- `order_line`: `id BIGINT UNSIGNED` PK, `order_id BIGINT UNSIGNED`, `variant_id
  BIGINT UNSIGNED`, `sku VARCHAR(64)`, `name_snapshot VARCHAR(255)`, `quantity INT`,
  four `BIGINT` money columns (tax/discount DEFAULT 0), `status ENUM`, timestamps +
  **inert `deleted_at`** (added — task DDL omitted it; same `BaseEntity` reason as
  `cart_line`). FKs `FK_ORDER_LINE_ORDER→order(id) ON DELETE RESTRICT`,
  `FK_ORDER_LINE_VARIANT→product_variant(id) ON DELETE RESTRICT`. Index
  `IDX_ORDER_LINE_ORDER (order_id)`. `utf8mb4_unicode_ci`.
- **Entity shapes:** `OrderEntity`/`OrderLineEntity` keep `BaseEntity`'s numeric PK
  (migration widens to BIGINT). `OrderEntity` uses `@VersionColumn`. **`OrderLineEntity`
  maps the owning order through the `@ManyToOne` relation alone — NO scalar `order_id`
  column** (relation-only, like `cart_line`, though `order_id` is numeric so a twin
  mapping would also be legal). `variant_id` is a plain BIGINT scalar, **no
  `@ManyToOne`** (opaque). `AddressEntity` overrides the PK with `CHAR(36)` via the
  `Omit<BaseEntity,'id'>` technique (the `CartEntity`/`StockLocationEntity` shape).
  Mappers coerce BIGINT strings with `Number(...)`.

### Contracts (`libs/contracts/retail`)

- **Five new enums** (`enums/`): `OrderStatusEnum`
  (`pending`/`confirmed`/`cancelled`/`shipped`/`delivered`),
  `OrderPaymentStatusEnum` (`none`/`authorized`/`captured`/`refunded`/`failed`),
  `OrderFulfillmentStatusEnum`
  (`unfulfilled`/`partially-shipped`/`shipped`/`delivered`), `OrderLineStatusEnum`
  (`allocated`/`shipped`/`partially-shipped`/`cancelled`/`returned`),
  `AddressOwnerTypeEnum` (`customer`/`order`).
- **DTOs** (`dto/`): `OrderView` (header: `id`, `orderNumber`, `customerId`,
  `currency`, the three statuses, the five money totals, `billingAddressId`,
  `shippingAddressId`, `placedAt`, `version`, `lines: OrderLineView[]`; **`payment:
  PaymentView` is NOT added yet** — task-04/06 add it), `OrderLineView` (`id`,
  `variantId`, `sku`, `nameSnapshot`, `quantity`, `unitPriceMinor`, `taxAmountMinor`,
  `discountAmountMinor`, `lineTotalMinor`, `status`), `AddressView`. All classes with
  `@ApiResponseProperty`. Re-exported from the dto/enums barrels.

### Module wiring

`orders.module.ts` (`infrastructure/`): `DatabaseModule.forFeature([OrderEntity,
OrderLineEntity, AddressEntity])`, provides `OrderTypeormRepository` +
`AddressTypeormRepository` + the two `useExisting` port bindings, exports
`ORDER_REPOSITORY` + `ADDRESS_REPOSITORY`. Module barrel `modules/orders/index.ts`
exports `orderEntities` + `OrdersModule`. Retail `app.module.ts` now
`DatabaseModule.forRoot([...cartEntities, ...orderEntities])` + imports `OrdersModule`.

> **DEVIATION:** `cartEntities` was **retyped** from `TypeOrmModuleOptions['entities']`
> to a plain concrete array (and `orderEntities` is a plain concrete array) so both
> are **spreadable** into the merged `forRoot([...cartEntities, ...orderEntities])`.

## Files added / modified

**Added** (under `apps/retail-microservice/src/modules/orders/` unless noted):
- `domain/order.model.ts`, `order-line.model.ts`, `address.model.ts`,
  `order.exception.ts`, `index.ts`
- `domain/spec/order.model.spec.ts`, `order-line.model.spec.ts`,
  `address.model.spec.ts`
- `application/ports/order.repository.port.ts`, `address.repository.port.ts`,
  `index.ts`
- `infrastructure/persistence/{order,order-line,address}.entity.ts`,
  `{order,order-line,address}.mapper.ts`, `order-typeorm.repository.ts`,
  `address-typeorm.repository.ts`, `index.ts`
- `infrastructure/persistence/spec/order-typeorm.repository.spec.ts`,
  `address-typeorm.repository.spec.ts`
- `infrastructure/orders.module.ts`
- `index.ts`
- `libs/contracts/retail/enums/{order-status,order-payment-status,order-fulfillment-status,order-line-status,address-owner-type}.enum.ts`
- `libs/contracts/retail/dto/{order.view,address.view}.ts`
- `migrations/1781101255857-CreateOrderLineAddressTables.ts`
- `docs/implementation/05-cart-order-payment-walking-skeleton/03-order-three-status-and-q4-decision.md`
- `docs/implementation/05-cart-order-payment-walking-skeleton/06-address-polymorphic-snapshot.md`

**Modified**:
- `apps/retail-microservice/src/app/app.module.ts` — `forRoot([...cartEntities,
  ...orderEntities])` + `OrdersModule`.
- `apps/retail-microservice/src/modules/cart/infrastructure/persistence/index.ts` —
  `cartEntities` retyped to a concrete (spreadable) array.
- `libs/contracts/retail/{enums/index,dto/index}.ts` — export the new contracts.
- `README.md` (services table, system-diagram retail box + DB box, retail section +
  app tree) + `CLAUDE.md` (app tree retail line, contracts retail sub-area, DB entity
  locations, new `modules/orders/` section). **CLAUDE.md is git-excluded
  (`.git/info/exclude`)** — edits are on disk but won't show in `git status`.

No ADR introduced — ADR-028 governs.

## Known gaps / deferrals (each names its owning task)

- **`Payment` aggregate + `PAYMENT_GATEWAY` port + `FakePaymentGatewayAdapter`**
  (inside **this** `orders/` module; reuse `OrderDomainException`) + `PaymentView` on
  `OrderView` → **task-04**.
- Cart **operations** + gateway + guest promotion → **task-05**.
- **Place Order** (cart→order snapshot, `markConverted`, `Address.forOrder` snapshots,
  authorize-on-place via `PAYMENT_GATEWAY`, `markPaymentAuthorized`,
  `retail.order.placed` event, `findBySourceCartId` idempotency) → **task-06**.
- **Capture + Get + List** (`markPaymentCaptured`, `listByCustomer`, `order:capture`
  permission, owner-checked customer reads, the HTTP **gateway orders module**, seed)
  → **task-07**.
- Notification re-point (`retail.order.placed` consumer + e2e) → **task-08**.
- README/CLAUDE full retail rewrite + lint fixtures + `http/*.http` → **task-09**.

## How to verify (all green as of this task)

- `yarn build` — all five apps compile.
- `yarn lint` — clean (`--max-warnings 0`).
- `yarn test:unit` — **583 pass** (was 529; +54 from the orders domain/repository
  specs).
- **Migration round-trip** (infra up): `yarn migration:run` creates `address` /
  `order` / `order_line` (three orthogonal ENUM status columns, `version`, the
  `UC_ORDER_NUMBER` UNIQUE, FKs to `customer`/`address`/`cart`/`product_variant`,
  `IDX_ADDRESS_OWNER` + `IDX_ORDER_CUSTOMER_PLACED` + `IDX_ORDER_LINE_ORDER`);
  `yarn migration:revert` drops all three; `yarn migration:run` re-creates —
  **verified clean**.
- `yarn test:e2e` — full infra reload (`down -v` → up → migrate incl.
  CreateOrderLineAddressTables → seed) + **88 e2e pass** (10 suites). No order e2e yet.
- **Live repository round-trip** (throwaway ts-node script, since removed): Address
  snapshot (`gb→GB`, `ownerType=order`), `Order.place` → `save` yielded
  `ORD-2026-00000001` from id=1 with concrete line ids + correct totals,
  `markPaymentAuthorized` re-save kept `order_number` and advanced payment,
  `findById`/`findBySourceCartId`/`listByCustomer` all correct.
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- Boot: retail listens on `retail_queue` with the `cart` + `orders` modules
  registered (no handlers).
