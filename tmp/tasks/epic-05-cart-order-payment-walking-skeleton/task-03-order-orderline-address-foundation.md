---
epic: epic-05
task_number: 3
title: Order + OrderLine + Address aggregate foundation (three orthogonal statuses, line snapshots, polymorphic address)
depends_on: [1, 2]
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/03-order-three-status-and-q4-decision.md
---

# Task 03 — Order + OrderLine + Address aggregate foundation

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-028** (three orthogonal status fields (Q4); the immutable
Order with money-minor line snapshots; polymorphic snapshot-on-order Address; the
`version` OCC column ships now; one-shot conversion stores the source cart),
**ADR-004** (framework-free domain; ports return domain types), **ADR-019** (extend
`BaseEntity`; hand-authored migration; mysql2 BIGINTs come back as strings — coerce
in mappers), **ADR-024** (`order.customer_id` is **nullable** so deleting a customer
leaves an order tombstone), **ADR-025/ADR-027** (`variantId` is the opaque backbone —
no catalog `ProductVariant` import), **ADR-005** (the order/address enums + view
DTOs live in `@retail-inventory-system/contracts`).

## Goal

Stand up the immutable `Order` (with `OrderLine`) and the polymorphic `Address`
inside the retail `orders/` module — domain models (+ specs), entities + mappers,
the `IOrderRepositoryPort` + `OrderTypeormRepository` and the `IAddressRepositoryPort`
+ `AddressTypeormRepository`, the `order` / `order_line` / `address` migration, and
the order/address enums + view DTOs. **No use cases and no gateway yet** —
repository contract first (Place Order lands in task-06; Payment in task-04).

## Entry state assumed

- task-01 + task-02 complete: legacy order model gone; `cart` / `cart_line` live;
  `libs/contracts/retail` holds the cart contracts + `CartStatusEnum`; the four
  `retail.cart.*` keys exist; the gateway `customer` table (`CHAR(36)` UUID PK)
  survives as the FK target; the catalog `product_variant` table exists.
- The retail `orders/` module **does not exist** (task-01 deleted the legacy one).
  You create it fresh — no rename, no carried-over files.

## New domain model specifics

### Enums (`libs/contracts/retail/enums/`, wire contracts — they surface on the
order view DTO and are mapped to raw strings on the order entity ENUM columns):

- `OrderStatusEnum`: `PENDING='pending'`, `CONFIRMED='confirmed'`,
  `CANCELLED='cancelled'`, `SHIPPED='shipped'`, `DELIVERED='delivered'`.
- `OrderPaymentStatusEnum`: `NONE='none'`, `AUTHORIZED='authorized'`,
  `CAPTURED='captured'`, `REFUNDED='refunded'`, `FAILED='failed'`.
- `OrderFulfillmentStatusEnum`: `UNFULFILLED='unfulfilled'`,
  `PARTIALLY_SHIPPED='partially-shipped'`, `SHIPPED='shipped'`,
  `DELIVERED='delivered'`.
- `OrderLineStatusEnum`: `ALLOCATED='allocated'`, `SHIPPED='shipped'`,
  `PARTIALLY_SHIPPED='partially-shipped'`, `CANCELLED='cancelled'`,
  `RETURNED='returned'`.
- `AddressOwnerTypeEnum`: `CUSTOMER='customer'`, `ORDER='order'`.

> These three order status enums are **orthogonal** — Q4. They evolve
> independently (e.g. `paymentStatus=captured` while `fulfillmentStatus=unfulfilled`
> is a valid combination). Do **not** collapse them into one machine or couple
> their transitions in this epic.

### `Order` (framework-free aggregate;
`apps/retail-microservice/src/modules/orders/domain/order.model.ts`,
`extends AggregateRoot<number | null>`):
- Fields: `id: number | null`, `orderNumber: string` (human-facing, immutable),
  `customerId: string | null`, `currency: string` (CHAR(3), immutable on the row),
  `status: OrderStatusEnum`, `paymentStatus: OrderPaymentStatusEnum`,
  `fulfillmentStatus: OrderFulfillmentStatusEnum`, `lines: OrderLine[]`,
  `subtotalMinor`, `taxTotalMinor`, `discountTotalMinor`, `shippingTotalMinor`,
  `grandTotalMinor` (all integers, minor units), `billingAddressId: string | null`,
  `shippingAddressId: string | null`, `sourceCartId: string | null`,
  `placedAt: Date | null`, `version: number`, `createdAt?`, `updatedAt?`.
- Invariants:
  - ≥ 1 line; `currency` non-empty + immutable.
  - **Total invariant** (asserted in the spec): `grandTotalMinor = subtotalMinor +
    taxTotalMinor + shippingTotalMinor − discountTotalMinor`, and `subtotalMinor =
    Σ line.lineTotalMinor`. In this epic `taxTotalMinor`, `discountTotalMinor`,
    `shippingTotalMinor` are **0** (no tax/discount/shipping capability yet — the
    `tax_category` is a classification label only, ADR-026; tax computation,
    discounts, and shipping rating are later/excluded capabilities), so
    `grandTotalMinor = subtotalMinor = Σ line.lineTotalMinor`.
  - All money fields non-negative integers.
- `static place({ orderNumber, customerId, currency, lines, billingAddressId,
  shippingAddressId, sourceCartId, placedAt })` — the place-time factory: validates
  ≥ 1 line + currency, derives the totals from the lines, sets `status=PENDING`,
  `paymentStatus=NONE`, `fulfillmentStatus=UNFULFILLED`, `version 0`. (Lines arrive
  already snapshotted — see `OrderLine` — the factory does not fetch anything.)
- `static reconstitute(props)` — load path.
- Payment-status mutators (each **bumps `version`**, used in tasks 06/07):
  `markPaymentAuthorized()` (`NONE → AUTHORIZED`), `markPaymentCaptured()`
  (`AUTHORIZED → CAPTURED`). Reject invalid transitions. (Refund/fail land with
  later capabilities — do **not** add them now.)
- Do **not** add ship / deliver / cancel mutators — those belong to the fulfillment
  and cancellation capabilities; adding them now is dead, untested code.

### `OrderLine` (framework-free child entity;
`apps/.../orders/domain/order-line.model.ts`, `extends Entity<number | null>`):
- Fields: `id: number | null`, `variantId: number` (opaque), `sku: string`
  (snapshot), `nameSnapshot: string` (snapshot), `quantity: number`,
  `unitPriceMinor: number` (snapshot), `taxAmountMinor: number`,
  `discountAmountMinor: number`, `lineTotalMinor: number`, `status: OrderLineStatusEnum`.
- Invariants: positive `variantId`/`quantity`; non-empty `sku`/`nameSnapshot`;
  non-negative money; `lineTotalMinor = unitPriceMinor × quantity + taxAmountMinor −
  discountAmountMinor` (in this epic `taxAmountMinor = discountAmountMinor = 0`, so
  `lineTotalMinor = unitPriceMinor × quantity`). `status` defaults to `ALLOCATED` at
  place-time (a forward-compatible sentinel — real allocation is the
  inventory-reservation capability).
- The snapshot fields (`sku`, `nameSnapshot`, `unitPriceMinor`) are **immutable
  post-construction** (no setters — the spec asserts this). They are the contract
  with the buyer, decoupled from any later catalog change.

### `Address` (framework-free aggregate; `apps/.../orders/domain/address.model.ts`,
`extends AggregateRoot<string | null>` — UUID string PK):
- Fields: `id: string | null`, `ownerType: AddressOwnerTypeEnum`, `ownerId: string`,
  `recipientName`, `line1`, `line2: string | null`, `city`, `region`, `postalCode`,
  `country` (CHAR(2) ISO), `phone: string | null`, `createdAt?`, `updatedAt?`.
- Invariants: `recipientName`/`line1`/`city`/`region`/`postalCode` non-empty;
  `country` matches `^[A-Z]{2}$` (2-char ISO, upper-cased); `ownerType` is one of the
  two enum values.
- `static forOrder({ orderId, recipientName, … })` factory sets `ownerType=ORDER`,
  `ownerId=orderId`. (The `customer` owner type ships in the enum for the future
  address-book capability but has no producer in this epic.)
- An Order's billing/shipping addresses are **snapshot copies** created at
  place-time from the request body — never references to a customer address book.

## Repository ports

`IOrderRepositoryPort` (`ORDER_REPOSITORY`;
`apps/.../orders/application/ports/order.repository.port.ts`) — domain types only:

```ts
findById(id: number): Promise<Order | null>;
findBySourceCartId(cartId: string): Promise<Order | null>;   // repeat-place idempotency (task-06)
save(order: Order): Promise<Order>;                          // upsert root + lines; re-reads for ids
listByCustomer(customerId: string, page: IPageRequest): Promise<IPage<Order>>; // List My Orders (task-07)
nextOrderNumber(): Promise<string>;                          // see "order_number" below
```

`IAddressRepositoryPort` (`ADDRESS_REPOSITORY`;
`apps/.../orders/application/ports/address.repository.port.ts`):

```ts
save(address: Address): Promise<Address>;          // re-reads for the concrete UUID/id
findById(id: string): Promise<Address | null>;
findByOwner(ownerType: AddressOwnerTypeEnum, ownerId: string): Promise<Address[]>;
```

Use the framework-free `IPage` / `IPageRequest` from `@retail-inventory-system/common`
(catalog declares its own local `IPage` in contracts — either is acceptable; prefer
`libs/common` to avoid leaking a pagination shape into the wire contract). Implement
`OrderTypeormRepository` + `AddressTypeormRepository` (the only `@InjectRepository`
sites for the module); both re-read the saved graph for concrete ids.

### `order_number` generation

`nextOrderNumber()` returns a human-facing, unique, immutable string of the form
`ORD-<year>-<8-digit-zero-padded-sequence>` (e.g. `ORD-2026-00000001`). For the
walking skeleton, derive it deterministically from the order's assigned `id` after
the first insert: persist the Order, read back the generated `id`, then set
`orderNumber = ORD-${placedAt.getUTCFullYear()}-${String(id).padStart(8,'0')}` and
persist again (the "re-read the saved graph, then finalize a derived field" idiom).
Uniqueness is backed by the `UNIQUE` index on `order.order_number`. (A dedicated
monotonic sequence is a later refinement — note it in doc `03`.) `nextOrderNumber()`
may therefore be realized as a post-save step inside `save`/the use case rather than
a standalone counter; document whichever you choose.

## Persistence specifics

`OrderEntity` / `OrderLineEntity` / `AddressEntity` extend `BaseEntity`.
`order.id` / `order_line.id` keep generated `BIGINT` PKs. **`address.id` is a
`CHAR(36)` UUID string PK** (override the inherited PK, generate with `randomUUID()`
on create). Map `variant_id` as a **plain `BIGINT` scalar, no `@ManyToOne`**.
`order.version` uses `@VersionColumn()`. The billing/shipping address ids are plain
`CHAR(36)` FKs to `address.id` (no `@ManyToOne` needed — they are snapshot pointers;
a plain column + FK is enough). `order_line.order_id → order.id` is
`@ManyToOne`/`@OneToMany` with `cascade: ['insert','update']`. `deletedAt` stays
inert on all three (Order/OrderLine are append-only; Address is immutable). Fields
camelCase; `SnakeNamingStrategy` maps to snake_case.

### Migration (`yarn migration:create`)

One migration, e.g. `…-CreateOrderLineAddressTables`, `synchronize` off. Create in
FK-dependency order — `address` first (order references it), then `order`, then
`order_line`:

```sql
-- up
CREATE TABLE address (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  owner_type     ENUM('customer','order') NOT NULL,
  owner_id       VARCHAR(36)  NOT NULL,
  recipient_name VARCHAR(255) NOT NULL,
  line1          VARCHAR(255) NOT NULL,
  line2          VARCHAR(255) NULL,
  city           VARCHAR(128) NOT NULL,
  region         VARCHAR(128) NOT NULL,
  postal_code    VARCHAR(32)  NOT NULL,
  country        CHAR(2)      NOT NULL,
  phone          VARCHAR(32)  NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at     TIMESTAMP    NULL
) COLLATE = utf8mb4_unicode_ci;
CREATE INDEX IDX_ADDRESS_OWNER ON address (owner_type, owner_id);

CREATE TABLE `order` (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_number         VARCHAR(20)  NOT NULL,
  customer_id          CHAR(36)     NULL,
  currency             CHAR(3)      NOT NULL,
  status               ENUM('pending','confirmed','cancelled','shipped','delivered') NOT NULL DEFAULT 'pending',
  payment_status       ENUM('none','authorized','captured','refunded','failed')      NOT NULL DEFAULT 'none',
  fulfillment_status   ENUM('unfulfilled','partially-shipped','shipped','delivered') NOT NULL DEFAULT 'unfulfilled',
  subtotal_minor       BIGINT NOT NULL,
  tax_total_minor      BIGINT NOT NULL DEFAULT 0,
  discount_total_minor BIGINT NOT NULL DEFAULT 0,
  shipping_total_minor BIGINT NOT NULL DEFAULT 0,
  grand_total_minor    BIGINT NOT NULL,
  billing_address_id   CHAR(36)  NULL,
  shipping_address_id  CHAR(36)  NULL,
  source_cart_id       CHAR(36)  NULL,
  placed_at            TIMESTAMP NULL,
  version              INT       NOT NULL DEFAULT 0,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at           TIMESTAMP NULL,
  CONSTRAINT UC_ORDER_NUMBER UNIQUE (order_number),
  CONSTRAINT FK_ORDER_CUSTOMER FOREIGN KEY (customer_id)
    REFERENCES customer (id) ON DELETE SET NULL,
  CONSTRAINT FK_ORDER_BILLING_ADDRESS  FOREIGN KEY (billing_address_id)  REFERENCES address (id),
  CONSTRAINT FK_ORDER_SHIPPING_ADDRESS FOREIGN KEY (shipping_address_id) REFERENCES address (id),
  CONSTRAINT FK_ORDER_SOURCE_CART FOREIGN KEY (source_cart_id) REFERENCES cart (id) ON DELETE SET NULL
);
CREATE INDEX IDX_ORDER_CUSTOMER_PLACED ON `order` (customer_id, placed_at);

CREATE TABLE order_line (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id             BIGINT UNSIGNED NOT NULL,
  variant_id           BIGINT UNSIGNED NOT NULL,
  sku                  VARCHAR(64)  NOT NULL,
  name_snapshot        VARCHAR(255) NOT NULL,
  quantity             INT          NOT NULL,
  unit_price_minor     BIGINT       NOT NULL,
  tax_amount_minor     BIGINT       NOT NULL DEFAULT 0,
  discount_amount_minor BIGINT      NOT NULL DEFAULT 0,
  line_total_minor     BIGINT       NOT NULL,
  status               ENUM('allocated','shipped','partially-shipped','cancelled','returned') NOT NULL DEFAULT 'allocated',
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT FK_ORDER_LINE_ORDER FOREIGN KEY (order_id)
    REFERENCES `order` (id) ON DELETE RESTRICT,
  CONSTRAINT FK_ORDER_LINE_VARIANT FOREIGN KEY (variant_id)
    REFERENCES product_variant (id) ON DELETE RESTRICT
);
CREATE INDEX IDX_ORDER_LINE_ORDER ON order_line (order_id);
```

- `order` is a reserved word — backtick it everywhere.
- `order_line.order_id → order.id` is `ON DELETE RESTRICT` (orders are append-only).
- `down` drops `order_line`, then `order`, then `address`.
- If MySQL rejects any `CHECK`, enforce in the aggregate and note it in doc `03`.

## Contracts (`libs/contracts/retail`)

- `enums/` — `order-status.enum.ts` (`OrderStatusEnum`),
  `order-payment-status.enum.ts` (`OrderPaymentStatusEnum`),
  `order-fulfillment-status.enum.ts` (`OrderFulfillmentStatusEnum`),
  `order-line-status.enum.ts` (`OrderLineStatusEnum`),
  `address-owner-type.enum.ts` (`AddressOwnerTypeEnum`) + barrel.
- `dto/` — `order.view.ts`: `OrderView` (header: `id`, `orderNumber`, `customerId`,
  `currency`, `status`, `paymentStatus`, `fulfillmentStatus`, the five money
  totals, `billingAddressId`, `shippingAddressId`, `placedAt`, plus `lines:
  OrderLineView[]` and optional `payment: PaymentView` — added in task-04/06) and
  `OrderLineView` (`id`, `variantId`, `sku`, `nameSnapshot`, `quantity`,
  `unitPriceMinor`, `taxAmountMinor`, `discountAmountMinor`, `lineTotalMinor`,
  `status`); `address.view.ts`: `AddressView`. Classes with `@ApiResponseProperty`.
  Re-export all from the retail contracts barrels.

## Module wiring

Create `apps/.../orders/infrastructure/orders.module.ts`:
`DatabaseModule.forFeature([OrderEntity, OrderLineEntity, AddressEntity])`; provide
the two repositories + their port symbols. No use cases / publisher / controller
yet. Export the port symbols + an `orderEntities = [OrderEntity, OrderLineEntity,
AddressEntity]` barrel. Register these entities in retail `app.module.ts`
(`DatabaseModule.forRoot([...cartEntities, ...orderEntities])`) and import
`OrdersModule`.

## Files to add

- `apps/.../orders/domain/order.model.ts` (+ `spec/order.model.spec.ts`)
- `apps/.../orders/domain/order-line.model.ts` (+ `spec/order-line.model.spec.ts`)
- `apps/.../orders/domain/address.model.ts` (+ `spec/address.model.spec.ts`)
- `apps/.../orders/domain/index.ts`
- `apps/.../orders/application/ports/order.repository.port.ts`,
  `address.repository.port.ts`, `index.ts`
- `apps/.../orders/infrastructure/persistence/order.entity.ts`,
  `order-line.entity.ts`, `address.entity.ts`, the three mappers,
  `order-typeorm.repository.ts`, `address-typeorm.repository.ts`, `index.ts`
  (+ recommended repository specs), `orders.module.ts`
- `apps/.../orders/index.ts`
- `libs/contracts/retail/enums/{order-status,order-payment-status,order-fulfillment-status,order-line-status,address-owner-type}.enum.ts`
- `libs/contracts/retail/dto/{order.view,address.view}.ts`
- `migrations/<timestamp>-CreateOrderLineAddressTables.ts`
- `docs/implementation/05-cart-order-payment-walking-skeleton/03-order-three-status-and-q4-decision.md`
- `docs/implementation/05-cart-order-payment-walking-skeleton/06-address-polymorphic-snapshot.md`

## Files to modify

- `apps/retail-microservice/src/app/app.module.ts` — register the order entities;
  import `OrdersModule`.
- `libs/contracts/retail/{index,enums/index,dto/index}.ts` — export the new
  order/address contracts.

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`):
  - `order.model.spec.ts` — the three status fields evolve **independently**
    (construct an order, assert `paymentStatus=captured` coexists with
    `fulfillmentStatus=unfulfilled`); `currency` immutable; the total invariant
    (`grandTotal = Σ lineTotal + tax + shipping − discount`); `place` rejects 0
    lines; `markPaymentAuthorized`/`markPaymentCaptured` enforce valid transitions
    and bump `version`.
  - `order-line.model.spec.ts` — `unitPriceMinor`/`nameSnapshot`/`sku` immutable
    post-construction; `lineTotalMinor` derivation; `status` defaults to `allocated`.
  - `address.model.spec.ts` — `country` is 2-char ISO (reject `USA`/`u`); `ownerType`
    is one of the two enum values; required fields non-empty; `forOrder` sets
    `ownerType=order`.
  - (Recommended) repository specs — `save` round-trips concrete ids;
    `nextOrderNumber`/order-number derivation yields `ORD-<year>-00000001`;
    `findBySourceCartId` finds the order; `listByCustomer` paginates.
- **Migration** — `yarn migration:run` creates `address` / `order` / `order_line`
  (with `version`, the unique `order_number`, FKs to `customer` / `address` / `cart`
  / `product_variant`); `revert` drops them; re-apply works.
- **E2E** — no new e2e (no operations yet); the full suite stays green.

## Doc deliverable

Write two docs:

`03-order-three-status-and-q4-decision.md` — **Q4**: why three orthogonal status
fields (`status`, `paymentStatus`, `fulfillmentStatus`) rather than one machine;
draw each state set explicitly and give a valid cross-product example
(`paymentStatus=captured` + `fulfillmentStatus=unfulfilled`); the immutable Order +
money-minor line snapshots; the total invariant and why tax/discount/shipping are
0 in this capability (classification-only tax category, ADR-026; tax/discount/
shipping are later/excluded capabilities); the `version` OCC token; the
`order_number` derivation + uniqueness backstop; the `source_cart_id` link that
makes repeat-place idempotent.

`06-address-polymorphic-snapshot.md` — the `(owner_type, owner_id)` polymorphic
discriminator + composite index; why an Order's billing/shipping addresses are
**snapshot copies** (immutable, decoupled from a future customer address book), not
references; the `customer` owner type reserved for the address-book capability.

Cross-link `docs/adr/028-…md` and `02-cart-aggregate-and-q1-q3-decisions.md`.
Describe everything by capability — never by an epic/task number.

## Carryover to read

`carryover-01.md`, `carryover-02.md`.

## Carryover to produce

Write `carryover-03.md`. Capture: the `Order`/`OrderLine`/`Address` model APIs (the
`place` factory, the payment-status mutators, the snapshot immutability, the total
invariant, `Address.forOrder`); the five new enums; `IOrderRepositoryPort` +
`IAddressRepositoryPort` signatures + their symbols; the `order`/`order_line`/
`address` schema (the `order_number` UNIQUE, `source_cart_id` FK, nullable
`customer_id` tombstone, the three ENUM columns, `version`); the `order_number`
derivation strategy chosen; the `OrderView`/`OrderLineView`/`AddressView` contracts;
that the `orders/` module is registered and retail boots; that **no use cases /
gateway / publisher exist yet**. Deferrals: Payment + port → task-04; Place Order +
snapshots + authorize + events → task-06; Capture + Get + List + gateway → task-07.
List verify commands.

## Exit criteria

- [ ] `address`, `order`, `order_line` exist with the documented columns, the three
      orthogonal ENUM status columns, `order.version`, the `order_number` UNIQUE, the
      `source_cart_id` + nullable `customer_id` FKs, and the opaque `variant_id` FKs;
      the migration reverts + re-applies cleanly.
- [ ] `Order` + `OrderLine` + `Address` models + specs are green (incl. the
      independent-status, snapshot-immutability, total-invariant, and 2-char-country
      assertions); the repositories compile against their ports.
- [ ] The retail microservice boots with the `orders/` module registered (no
      handlers yet).
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` + `yarn test:e2e` pass.
- [ ] `03-order-three-status-and-q4-decision.md` + `06-address-polymorphic-snapshot.md`
      are written.
- [ ] The self-containment grep is clean.
- [ ] `carryover-03.md` is written.
