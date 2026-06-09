---
epic: epic-05
task_number: 2
title: Cart + CartLine aggregate foundation (domain, persistence, migration, contracts)
depends_on: [1]
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md
---

# Task 02 — Cart + CartLine aggregate foundation

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-028** (the chain decision recorded in task-01 — Cart is the
mutable aggregate, distinct from the immutable Order; the `version` OCC column
ships now), **ADR-004** (domain is framework-free — no `@nestjs/*`, no `typeorm`,
no `class-validator` on the model; ports under `application/ports/` return domain
types only), **ADR-019** (extend `BaseEntity`; `SnakeNamingStrategy`;
hand-authored migration; `synchronize` off; mysql2 BIGINT scalars come back as
strings — coerce with `Number(...)` in mappers), **ADR-025/ADR-027** (`variantId`
is the opaque downstream backbone key — never import the catalog `ProductVariant`;
the coupling is an FK in persistence), **ADR-008** (dotted routing keys; mirror
new keys in `MicroserviceMessagePatternEnum` + the spec), **ADR-005** (cross-service
DTOs/enums live in `@retail-inventory-system/contracts`).

## Goal

Stand up the `Cart` + `CartLine` aggregate in the retail microservice — domain
model (+ specs), TypeORM entities + mappers, the `ICartRepositoryPort` +
`CartTypeormRepository`, the `cart` / `cart_line` migration, the cart contracts
(enum + views), and the reserved-surface `retail.cart.*` event routing keys + wire
contracts. **No use cases and no gateway yet** — repository contract first (the
operations + gateway land in task-05). Retail boots with the new `cart` module
registered.

## Entry state assumed

- task-01 complete: the legacy order model is gone; the retail microservice boots
  order-free with `DatabaseModule.forRoot([])`; `libs/contracts/retail` is empty of
  order contracts; the six `retail.order.*` keys are retired; the gateway
  `customer` table (auth aggregate, `CHAR(36)` UUID PK) survives as the FK target.
- The catalog `product_variant` table exists (its `id` is `BIGINT UNSIGNED`).
- Latest migration is task-01's `…-DropLegacyOrderTables`.

## New domain model specifics

**`CartStatusEnum`** — lives in `libs/contracts/retail/enums/cart-status.enum.ts`
(it surfaces on the cart view DTO + the cart-created event, so it is a wire
contract): `ACTIVE = 'active'`, `ABANDONED = 'abandoned'`, `CONVERTED = 'converted'`.

**`Cart`** (framework-free aggregate;
`apps/retail-microservice/src/modules/cart/domain/cart.model.ts`,
`extends AggregateRoot<string | null>` — the id is a caller-or-DB-assigned UUID
string):
- Fields: `id: string | null`, `customerId: string | null` (the gateway customer
  UUID — guest or registered; nullable per ADR-028), `currency: string` (CHAR(3),
  immutable post-create), `status: CartStatusEnum`, `lines: CartLine[]`,
  `expiresAt: Date | null`, `version: number`, `createdAt?`, `updatedAt?`.
- Invariants: `currency` is a non-empty 3-letter code, **immutable** after create
  (no setter); `version ≥ 0` integer.
- `static create({ customerId, currency, expiresAt? })` → a new `active` cart,
  `version 0`, empty lines.
- `static reconstitute(props)` → load path (any status/version).
- Mutators (each **bumps `version`** so "version bumps on each mutation" is
  observable in the spec, and each may record a reserved-surface domain event the
  use case drains via `pullDomainEvents()`):
  - `addLine({ variantId, quantity, unitPriceSnapshotMinor, currencySnapshot })` —
    appends a `CartLine` (or, if a line for `variantId` exists, increments its
    quantity — pick one and document it; **increment-existing** is the cleaner
    cart UX and what task-05's tests assume). Rejects a non-`active` cart. Records
    `CartLineAddedEvent`.
  - `changeLineQuantity(lineId, quantity)` — sets a line's quantity (positive
    integer; `0` is rejected — removal is the explicit op). Rejects a non-`active`
    cart. Records `CartLineQuantityChangedEvent`.
  - `removeLine(lineId)` — drops a line. Rejects a non-`active` cart. Records
    `CartLineRemovedEvent`.
  - `markConverted()` — `active → converted` (called by Place Order in task-06).
    Rejects if not `active`.
  - `markAbandoned()` — `active → abandoned` (no producer yet; ships for the purge
    capability).
- A `get total(): { subtotalMinor: number; currency: string }` convenience getter
  (Σ `unitPriceSnapshotMinor × quantity`) is useful for the cart view; keep it pure.

**`CartLine`** (framework-free child entity;
`apps/.../cart/domain/cart-line.model.ts`, `extends Entity<number | null>`):
- Fields: `id: number | null`, `variantId: number` (opaque — **never** import the
  catalog `ProductVariant`), `quantity: number`, `unitPriceSnapshotMinor: number`,
  `currencySnapshot: string`.
- Invariants: `variantId` positive integer; `quantity` positive integer (`> 0`);
  `unitPriceSnapshotMinor` non-negative integer; `currencySnapshot` non-empty.
- The snapshot fields are **captured at add time and stay stable** when sibling
  lines mutate (the spec asserts this).

**Domain events** (`apps/.../cart/domain/events/`, framework-free
`DomainEvent<string>` subclasses keyed on `cartId`): `CartCreatedEvent`,
`CartLineAddedEvent` (carries `variantId`, `quantity`), `CartLineRemovedEvent`
(carries `lineId`), `CartLineQuantityChangedEvent` (carries `lineId`, `quantity`).
Barrel them. They map to the versioned `v1` wire events in the use case (task-05) —
**never serialize a `DomainEvent` subclass across services** (ADR-011).

## Repository port

`ICartRepositoryPort` (`CART_REPOSITORY` symbol;
`apps/.../cart/application/ports/cart.repository.port.ts`) — domain types only, no
`typeorm` import:

```ts
findById(id: string): Promise<Cart | null>;
save(cart: Cart): Promise<Cart>;            // upsert root + lines; re-reads for concrete ids
reassignCustomer(cartId: string, customerId: string): Promise<void>; // guest-promotion (task-05)
```

`save` re-reads the saved graph so generated `cart_line.id`s come back concrete
(the "re-read the saved graph" idiom `CatalogTypeormRepository` uses). Implement in
`CartTypeormRepository` (the only `@InjectRepository` site for this module).

## Persistence specifics

`CartEntity` / `CartLineEntity` extend `BaseEntity`. **`cart.id` is a caller/DB
`CHAR(36)` UUID string PK** — override the PK column to a string primary column
(generate the UUID in the app, e.g. `randomUUID()`, on create; do **not** rely on
the inherited auto-increment `id`). `CartLineEntity` keeps a generated `BIGINT` PK.
Map `variant_id` as a **plain `BIGINT` scalar with no `@ManyToOne`** (opaque link).
`version` uses TypeORM `@VersionColumn()`. Fields camelCase; `SnakeNamingStrategy`
maps to snake_case. `deletedAt` stays inert (Cart is purged by status, not
soft-deleted). The cart↔line relation is `@OneToMany` / `@ManyToOne` with
`cascade: ['insert','update']` and `onDelete: 'CASCADE'`.

### Migration (`yarn migration:create`)

One migration, e.g. `…-CreateCartTables`, `synchronize` off:

```sql
-- up
CREATE TABLE cart (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  customer_id CHAR(36)    NULL,
  currency    CHAR(3)     NOT NULL,
  status      ENUM('active','abandoned','converted') NOT NULL DEFAULT 'active',
  expires_at  TIMESTAMP   NULL,
  version     INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at  TIMESTAMP   NULL,
  CONSTRAINT FK_CART_CUSTOMER FOREIGN KEY (customer_id)
    REFERENCES customer (id) ON DELETE SET NULL
) COLLATE = utf8mb4_unicode_ci;

CREATE TABLE cart_line (
  id                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  cart_id                   CHAR(36)        NOT NULL,
  variant_id                BIGINT UNSIGNED NOT NULL,
  quantity                  INT             NOT NULL,
  unit_price_snapshot_minor BIGINT          NOT NULL,
  currency_snapshot         CHAR(3)         NOT NULL,
  created_at                TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT FK_CART_LINE_CART FOREIGN KEY (cart_id)
    REFERENCES cart (id) ON DELETE CASCADE,
  CONSTRAINT FK_CART_LINE_VARIANT FOREIGN KEY (variant_id)
    REFERENCES product_variant (id) ON DELETE RESTRICT,
  CONSTRAINT CK_CART_LINE_QTY CHECK (quantity > 0)
);
CREATE INDEX IDX_CART_LINE_CART ON cart_line (cart_id);
```

- `down` drops `cart_line` then `cart`.
- If the running MySQL rejects `CHECK`, enforce `quantity > 0` only in the aggregate
  + use cases and note the omission in doc `02`.

## Contracts (`libs/contracts/retail`)

- `enums/cart-status.enum.ts` (`CartStatusEnum`) + barrel.
- `dto/cart.view.ts` — RPC/HTTP response shape: `CartView`
  (`id`, `customerId`, `currency`, `status`, `expiresAt`, `version`, `lines:
  CartLineView[]`, `subtotalMinor`) and `CartLineView`
  (`id`, `variantId`, `quantity`, `unitPriceSnapshotMinor`, `currencySnapshot`,
  `lineSubtotalMinor`). Classes with `@ApiResponseProperty` (the documented
  lib-contracts Swagger exception, mirroring `PriceView`/`ProductView`).
- `events/` — wire contracts extending `ICorrelationPayload` + `occurredAt: string`:
  - `IRetailCartCreatedEvent` `{ cartId, customerId, currency, eventVersion: 'v1' }`
  - `IRetailCartLineAddedEvent` `{ cartId, variantId, quantity, eventVersion: 'v1' }`
  - `IRetailCartLineRemovedEvent` `{ cartId, lineId, eventVersion: 'v1' }`
  - `IRetailCartLineQuantityChangedEvent` `{ cartId, lineId, quantity, eventVersion: 'v1' }`
  Barrel them. Re-export everything from `libs/contracts/retail/index.ts` (remove
  the task-01 `export {};` placeholder if present).

## Routing keys

Add to `libs/messaging/routing-keys.constants.ts` (+ mirror in
`MicroserviceMessagePatternEnum` + update `routing-keys.constants.spec.ts`):
- `RETAIL_CART_CREATED: 'retail.cart.created'`
- `RETAIL_CART_LINE_ADDED: 'retail.cart.line-added'`
- `RETAIL_CART_LINE_REMOVED: 'retail.cart.line-removed'`
- `RETAIL_CART_LINE_QUANTITY_CHANGED: 'retail.cart.line-quantity-changed'`

These are **reserved-surface events** (no consumer yet). The cart RPC command keys
(`retail.cart.create` / `.get` / line ops) are added in task-05 (where the handlers
that serve them land).

## Module wiring

Create `apps/.../cart/infrastructure/cart.module.ts`:
`DatabaseModule.forFeature([CartEntity, CartLineEntity])`; provide
`CartTypeormRepository` + `{ provide: CART_REPOSITORY, useExisting: CartTypeormRepository }`.
No publisher / use cases / controller yet. Export `CART_REPOSITORY` and a
`cartEntities = [CartEntity, CartLineEntity]` barrel. Register the cart entities in
retail `app.module.ts` via `DatabaseModule.forRoot(cartEntities)` and import
`CartModule`.

## Files to add

- `apps/.../cart/domain/cart.model.ts` (+ `spec/cart.model.spec.ts`)
- `apps/.../cart/domain/cart-line.model.ts` (+ `spec/cart-line.model.spec.ts`)
- `apps/.../cart/domain/events/*` (`cart-created`, `cart-line-added`,
  `cart-line-removed`, `cart-line-quantity-changed`, `index.ts`)
- `apps/.../cart/domain/index.ts`
- `apps/.../cart/application/ports/cart.repository.port.ts` (+ `index.ts`)
- `apps/.../cart/infrastructure/persistence/cart.entity.ts`,
  `cart-line.entity.ts`, `cart.mapper.ts`, `cart-line.mapper.ts`,
  `cart-typeorm.repository.ts`, `index.ts` (+ `spec/cart-typeorm.repository.spec.ts`
  recommended), `cart.module.ts`
- `apps/.../cart/index.ts`
- `libs/contracts/retail/enums/cart-status.enum.ts`
- `libs/contracts/retail/dto/cart.view.ts`
- `libs/contracts/retail/events/cart-created.event.ts`,
  `cart-line-added.event.ts`, `cart-line-removed.event.ts`,
  `cart-line-quantity-changed.event.ts`
- `migrations/<timestamp>-CreateCartTables.ts`
- `docs/implementation/05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md`

## Files to modify

- `apps/retail-microservice/src/app/app.module.ts` — `DatabaseModule.forRoot(cartEntities)`;
  import `CartModule`.
- `libs/contracts/retail/{index,enums/index,dto/index,events/index}.ts` — export the
  new cart contracts.
- `libs/messaging/routing-keys.constants.ts` + `spec/routing-keys.constants.spec.ts`;
  `libs/contracts/microservices/microservice-message-pattern.enum.ts`.

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`):
  - `cart.model.spec.ts` — `create` yields an `active` cart with `version 0`;
    `currency` non-empty + immutable; `addLine` / `changeLineQuantity` /
    `removeLine` each bump `version` and record the matching domain event; mutating
    a non-`active` cart is rejected; `changeLineQuantity(0)` rejected;
    `markConverted` only from `active`.
  - `cart-line.model.spec.ts` — positive `quantity`/`variantId`, non-negative
    `unitPriceSnapshotMinor`; the snapshot stays stable when a sibling line's
    quantity changes (mutate line B, assert line A's snapshot unchanged).
  - `cart-typeorm.repository.spec.ts` (recommended) — `save` upserts the root +
    lines and re-reads concrete `cart_line.id`s; `findById` returns the graph;
    `reassignCustomer` updates `customer_id`.
- **Migration** — `yarn migration:run` creates `cart` + `cart_line` (with the
  `version` column + FKs); `yarn migration:revert` drops them; re-apply works.
- **E2E** — no new e2e (no operations yet). The full suite stays green (cart tables
  exist but unreferenced by any spec until task-05).

## Doc deliverable

`02-cart-aggregate-and-q1-q3-decisions.md` — **started** here (task-05 completes
the Q1 guest-promotion section). Cover: **Q3** — Cart and Order are distinct
aggregates (the mutable cart vs the immutable order), and why this prevents a
post-placement cart edit from corrupting the order record; the `Cart`/`CartLine`
model (status machine `active → converted`/`abandoned`, line snapshot semantics,
the `version` OCC token shipped now though enforcement is a later
concurrency-hardening capability); the `cart`/`cart_line` schema + the opaque
`variant_id` FK; the reserved-surface `retail.cart.*` events. Leave a clearly
marked "Guest carts (Q1)" placeholder section that task-05 fills in. Cross-link
`docs/adr/028-…md`. Describe everything by capability — never by an epic/task
number.

## Carryover to read

`carryover-01.md`.

## Carryover to produce

Write `carryover-02.md`. Capture: the `Cart`/`CartLine` model API (factories,
mutators, `version`-bump behaviour, the increment-existing-line decision in
`addLine`); `CartStatusEnum` values; `ICartRepositoryPort` method signatures +
`CART_REPOSITORY`; `cart`/`cart_line` schema + the `cart.id` `CHAR(36)` UUID-PK
divergence from `BaseEntity`; the cart `CartView`/`CartLineView` contracts + the
four `retail.cart.*` reserved event keys; that the cart module is registered and
retail boots with it; that **no cart use cases or gateway exist yet**. Deferrals:
cart operations + gateway + guest promotion → task-05; Order/Address foundation →
task-03. List verify commands (`yarn lint`, `test:unit`, `migration:run`/`revert`,
the grep).

## Exit criteria

- [ ] `cart` + `cart_line` exist with the documented columns, FKs, indexes, and the
      `version` column; the migration reverts + re-applies cleanly.
- [ ] `Cart` + `CartLine` models + specs are green; the repository compiles against
      `ICartRepositoryPort` and (recommended) its spec is green.
- [ ] The retail microservice boots with the `cart` module registered (no handlers
      yet); `yarn start:dev:retail-microservice` is clean.
- [ ] The four `retail.cart.*` keys exist in `ROUTING_KEYS` +
      `MicroserviceMessagePatternEnum` and the routing-keys spec is green.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `yarn test:e2e` passes.
- [ ] `02-cart-aggregate-and-q1-q3-decisions.md` is written (Q3 + aggregate; Q1
      placeholder marked).
- [ ] The self-containment grep is clean.
- [ ] `carryover-02.md` is written.
