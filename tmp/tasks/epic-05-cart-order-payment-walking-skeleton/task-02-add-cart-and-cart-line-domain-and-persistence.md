---
epic: epic-05
task_number: 2
title: Add `cart` + `cart_line` tables, domain, persistence, mappers
depends_on: [01]
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md (intro half — task-05 appends the use-case half)
---

# Task 02 — Add `cart` + `cart_line` domain and persistence

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing. Especially relevant here: [ADR-004](../../docs/adr/004-adopt-hexagonal-architecture-per-service.md) (per-module hexagonal layout — the new `modules/cart/` is a peer to `modules/orders/`), [ADR-005](../../docs/adr/005-split-shared-common-into-bounded-libs.md) (the `BaseEntity` extension policy + Naming strategy), [ADR-019](../../docs/adr/019-typeorm-and-mysql-for-persistence.md) (entity conventions, `@VersionColumn()` semantics; the OCC retrofit-friendly column is added here even though `epic-12` enforces it), and [ADR-013](../../docs/adr/013-order-aggregate-and-cross-service-confirm.md) (the canonical per-module template the new `cart/` follows).

## Goal

Land the `Cart` aggregate + `CartLine` child entity as a brand-new bounded context under `apps/retail-microservice/src/modules/cart/`. This task ships the domain, the persistence layer (entities + mappers + repository), the new module file, and the migration. **No use cases yet** — the repository's contract is settled first; task-05 builds the five use cases (CreateCart / AddToCart / RemoveCartLine / ChangeCartLineQuantity / GetCart) against the port shape this task defines.

The `Cart` aggregate carries Open Question Q1's persistence shape: it has an `id` (UUID — guests get one without a customer row; auth-side customers get one with their customer id), a `customerId` (nullable for guest carts pre-promotion; non-null after promotion), a `status` (`active` | `abandoned` | `converted`), `currency` (immutable post-create), `expiresAt` (TIMESTAMP nullable — `null` means "no expiry today" for the walking skeleton; epic-12 introduces sweep-based abandonment), and `version` (the forward-looking OCC token — bumped on every domain-level mutation per task-04's `@VersionColumn()` convention; OCC enforcement lands in `epic-12`). `CartLine` carries a snapshot `unitPriceSnapshotMinor` + `currencySnapshot` captured at add-time (task-05 wires the catalog-side Select Applicable Price RPC; this task ships the snapshot fields and their invariants).

Open Question Q3 is honored implicitly: `Cart` is not a parent of `Order`. The one-shot conversion (task-06's `PlaceOrderUseCase`) reads the cart, writes the order, and flips `cart.status='converted'` in one transaction — but the two aggregates own separate tables and separate repositories.

## Entry state assumed

Task-01 carryover present:

- The five legacy retail tables are gone; `OrderTypeormRepository` is a throwing stub.
- `apps/retail-microservice/src/modules/orders/` is the existing (now-emptied) hexagonal layout.
- `apps/retail-microservice/src/modules/cart/` **does not yet exist** — this task creates the folder structure (`domain/`, `application/ports/`, `infrastructure/persistence/`, `infrastructure/cart.module.ts`; no `presentation/` yet — task-05 adds it).
- `libs/contracts/retail/` carries no `cart/` subarea yet — this task creates `libs/contracts/retail/cart/` for the cross-service event payload interfaces (the actual events are emitted by task-05; the interfaces ship here so the publisher port in task-05 has a typed surface to depend on).
- `libs/messaging/routing-keys.constants.ts` carries no `RETAIL_CART_*` constants yet. This task does **not** add them — task-05 owns the routing-key constants alongside its publisher wiring.

## Scope

**In:**

- New folder structure under `apps/retail-microservice/src/modules/cart/`:
  - `domain/cart.model.ts` — the aggregate root.
  - `domain/cart-line.model.ts` — child entity.
  - `domain/cart-status.enum.ts` — `'active' | 'abandoned' | 'converted'`.
  - `domain/events/cart-created.event.ts` — payload `{ cartId, customerId, currency }`.
  - `domain/events/cart-line-added.event.ts` — payload `{ cartId, lineId, variantId, quantity, unitPriceSnapshotMinor, currencySnapshot }`.
  - `domain/events/cart-line-removed.event.ts` — `{ cartId, lineId }`.
  - `domain/events/cart-line-quantity-changed.event.ts` — `{ cartId, lineId, newQuantity, previousQuantity }`.
  - `domain/spec/cart.model.spec.ts`, `domain/spec/cart-line.model.spec.ts` — unit tests.
  - `domain/index.ts` — barrel exports.
- `application/ports/cart.repository.port.ts` + `application/ports/index.ts`:
  - `ICartRepositoryPort` with methods `save(cart: Cart): Promise<Cart>`, `findById(id: string): Promise<Cart | null>`, `findActiveByCustomerId(customerId: string): Promise<Cart | null>` (used by task-05's CreateCart to dedupe a single live cart per customer — the alternative of allowing many overlapping carts is deferred to `epic-12`).
  - `CART_REPOSITORY` DI symbol.
- `infrastructure/persistence/cart.entity.ts` — TypeORM entity. PK is `id: string` (UUID; **not** `BaseEntity`'s int auto-increment, because guest carts are referenced by their UUID in cookies before login; the column is `CHAR(36)` and the entity overrides the PK). Use `@PrimaryColumn({ type: 'char', length: 36 })` and `@BeforeInsert` to default the id from `crypto.randomUUID()` if unset. `createdAt` / `updatedAt` / `deletedAt` are still inherited from a thin `TimestampedEntity` or declared inline (verify project convention by re-reading `libs/database/`'s base entity exports; if `BaseEntity` is the only export and its PK is int-only, declare the timestamp columns inline and reference `libs/common/types/` for the `Maybe` type if used).
- `infrastructure/persistence/cart-line.entity.ts` — TypeORM entity. PK is `id: BIGINT` auto-increment (matches the project's default). FK `cart_id → cart.id ON DELETE CASCADE` (cart lines are owned by the cart; deletion via cascade is acceptable here because `cart` itself is purgable). `unit_price_snapshot_minor` is `BIGINT`. `currency_snapshot` is `CHAR(3)`. `quantity` is positive `INT`.
- `infrastructure/persistence/cart.mapper.ts` and `cart-line.mapper.ts` — bidirectional domain ↔ entity translation. The mapper reconstructs the aggregate with its lines in load-time order via the `Cart.rehydrate(...)` static factory (see §"Cart aggregate shape" below).
- `infrastructure/persistence/cart-typeorm.repository.ts` — implements `ICartRepositoryPort`. Extends `BaseTypeormRepository` if the helpers fit (they will for the standard CRUD shape; the lines are loaded via `relations: ['lines']` in `findById`).
- `infrastructure/persistence/index.ts` — barrel.
- `infrastructure/cart.module.ts` — the `@Module({})` wiring:
  - `imports: [DatabaseModule.forFeature([CartEntity, CartLineEntity])]`
  - `providers: [{ provide: CART_REPOSITORY, useClass: CartTypeormRepository }, CartTypeormRepository]`
  - `exports: [CART_REPOSITORY]`
- `apps/retail-microservice/src/app/app.module.ts` updates: import the new `CartModule` alongside the existing `OrdersModule`.
- New migration `migrations/<timestamp>-CreateCartAndCartLineTables.ts`:
  - `cart` table: columns per the epic's "Persistence Changes" section. UUID PK as `CHAR(36)`. Indexes: PK on `id`; secondary index on `(customer_id, status)` for the `findActiveByCustomerId` query path (task-05 uses this); secondary index on `expires_at` for `epic-12`'s future sweep query (cheap to ship now).
  - `cart_line` table: columns per the epic. PK is `BIGINT` auto-increment. FK `cart_id → cart.id ON DELETE CASCADE`. Index `cart_line(cart_id)`.
  - `@VersionColumn()` mapped column on `cart` named `version` (`INT NOT NULL DEFAULT 0`).
  - Down migration: drops `cart_line` first (FK), then `cart`. Symmetric.
- `libs/contracts/retail/cart/` new subfolder:
  - `cart-status.enum.ts` — re-export of the domain enum (or a value-mirror — the project's convention is to keep the domain enum and `libs/contracts/` enum as the same TS value; verify against `libs/contracts/retail/orders/` shape).
  - `events/cart-created.event.ts`, `events/cart-line-added.event.ts`, `events/cart-line-removed.event.ts`, `events/cart-line-quantity-changed.event.ts` — interfaces extending `ICorrelationPayload` + `occurredAt: string`. Task-05's publisher consumes these.
  - `dto/` reserved (task-05 ships the request DTOs).
  - `index.ts` — barrel.
- `libs/contracts/retail/index.ts` — re-export the new `cart/` subarea.
- Doc deliverable `02-cart-aggregate-and-q1-q3-decisions.md` — intro half written here (Q1 + Q3 decisions, the aggregate shape, why Cart and Order are distinct aggregates). Task-05 appends the use-case-flow half.

**Out:**

- The five cart use cases — task-05.
- The `cart.controller.ts` `@MessagePattern` handlers — task-05.
- Registering routing-key constants for cart events — task-05.
- The api-gateway-side cart module — task-09.
- The guest-cart promotion logic (Q1 second half) — task-05 wires the promotion path because it lives inside the `AddToCart` / `CreateCart` use cases.

## Cart aggregate shape

```ts
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { CartLine } from './cart-line.model';
import { CartStatusEnum } from './cart-status.enum';
import {
  CartCreatedEvent,
  CartLineAddedEvent,
  CartLineQuantityChangedEvent,
  CartLineRemovedEvent,
} from './events';

export interface ICartProps {
  customerId: string | null;
  currency: string; // ISO 4217
  status: CartStatusEnum;
  expiresAt: Date | null;
  version: number;
  lines: CartLine[];
  createdAt: Date;
  updatedAt: Date;
}

export class Cart extends AggregateRoot<string> {
  private constructor(id: string, private props: ICartProps) {
    super(id);
  }

  // Construction for a fresh cart — task-05's CreateCart use case calls this.
  public static create(payload: {
    id: string;
    customerId: string | null;
    currency: string;
  }): Cart {
    const now = new Date();
    const cart = new Cart(payload.id, {
      customerId: payload.customerId,
      currency: payload.currency,
      status: CartStatusEnum.Active,
      expiresAt: null,
      version: 0,
      lines: [],
      createdAt: now,
      updatedAt: now,
    });
    cart.recordEvent(
      new CartCreatedEvent({
        cartId: cart.id,
        customerId: payload.customerId,
        currency: payload.currency,
      }),
    );
    return cart;
  }

  // Rehydration for the mapper — does NOT record an event.
  public static rehydrate(id: string, props: ICartProps): Cart {
    return new Cart(id, props);
  }

  public addLine(payload: {
    lineId: number | null; // null for new lines; mapper assigns on save
    variantId: number;
    quantity: number;
    unitPriceSnapshotMinor: number;
    currencySnapshot: string;
  }): CartLine {
    if (this.props.status !== CartStatusEnum.Active) {
      throw new Error('Cannot modify a non-active cart');
    }
    if (payload.currencySnapshot !== this.props.currency) {
      throw new Error(
        `Cart currency ${this.props.currency} does not match line snapshot ${payload.currencySnapshot}`,
      );
    }
    if (payload.quantity <= 0) throw new Error('quantity must be > 0');

    const existing = this.props.lines.find((l) => l.variantId === payload.variantId);
    if (existing) {
      // Idempotent merge — adding the same variant bumps the quantity.
      // (epic-05's Q3 implies one cart-line per variant; the alternative of
      // multiple lines per variant is owned by epic-12's discount-code shape.)
      this.changeLineQuantity(existing.id!, existing.quantity + payload.quantity);
      return existing;
    }

    const line = CartLine.create(payload);
    this.props.lines.push(line);
    this.props.updatedAt = new Date();
    this.props.version += 1;
    this.recordEvent(
      new CartLineAddedEvent({
        cartId: this.id,
        lineId: line.id ?? -1, // -1 sentinel — mapper rewrites on save
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceSnapshotMinor: line.unitPriceSnapshotMinor,
        currencySnapshot: line.currencySnapshot,
      }),
    );
    return line;
  }

  public removeLine(lineId: number): void {
    if (this.props.status !== CartStatusEnum.Active) {
      throw new Error('Cannot modify a non-active cart');
    }
    const idx = this.props.lines.findIndex((l) => l.id === lineId);
    if (idx === -1) throw new Error(`Cart line ${lineId} not found`);
    this.props.lines.splice(idx, 1);
    this.props.updatedAt = new Date();
    this.props.version += 1;
    this.recordEvent(new CartLineRemovedEvent({ cartId: this.id, lineId }));
  }

  public changeLineQuantity(lineId: number, newQuantity: number): void {
    if (this.props.status !== CartStatusEnum.Active) {
      throw new Error('Cannot modify a non-active cart');
    }
    if (newQuantity <= 0) throw new Error('quantity must be > 0');
    const line = this.props.lines.find((l) => l.id === lineId);
    if (!line) throw new Error(`Cart line ${lineId} not found`);
    const previous = line.quantity;
    if (previous === newQuantity) return; // no-op, no event
    line.setQuantity(newQuantity);
    this.props.updatedAt = new Date();
    this.props.version += 1;
    this.recordEvent(
      new CartLineQuantityChangedEvent({
        cartId: this.id,
        lineId,
        newQuantity,
        previousQuantity: previous,
      }),
    );
  }

  public markConverted(): void {
    if (this.props.status !== CartStatusEnum.Active) {
      throw new Error(`Cannot mark ${this.props.status} cart as converted`);
    }
    this.props.status = CartStatusEnum.Converted;
    this.props.updatedAt = new Date();
    this.props.version += 1;
    // No event here — task-06's PlaceOrder use case emits retail.order.placed
    // post-commit; the cart-conversion side-effect is implicit in the order
    // event. The doc deliverable explains why this is one event, not two.
  }

  // Linker used by task-05's guest-cart promotion (Q1 second half).
  public assignCustomerId(customerId: string): void {
    if (this.props.customerId !== null && this.props.customerId !== customerId) {
      throw new Error('Cart already owned by another customer');
    }
    if (this.props.customerId === customerId) return; // idempotent
    this.props.customerId = customerId;
    this.props.updatedAt = new Date();
    this.props.version += 1;
    // No event in this epic — task-12's epic-11 audit consumer can derive
    // promotions from the (customerId is null) → (customerId set) diff if a
    // later epic decides to make this auditable. Keep the surface minimal.
  }

  // Accessors — every field exposed read-only via a getter.
  public get customerId(): string | null { return this.props.customerId; }
  public get currency(): string { return this.props.currency; }
  public get status(): CartStatusEnum { return this.props.status; }
  public get expiresAt(): Date | null { return this.props.expiresAt; }
  public get version(): number { return this.props.version; }
  public get lines(): readonly CartLine[] { return [...this.props.lines]; }
  public get createdAt(): Date { return this.props.createdAt; }
  public get updatedAt(): Date { return this.props.updatedAt; }
}
```

Three notes for the implementer:

- `Cart.create(...)` takes a pre-generated `id` so the use case (task-05) controls UUID generation (the alternative of `id = crypto.randomUUID()` inside `create()` makes the aggregate harder to test — the test would have to mock `crypto`, or accept a non-deterministic id). The use case calls `crypto.randomUUID()` and passes it in.
- The `lineId` in the `CartLineAddedEvent` is `-1` for fresh lines because the BIGINT auto-increment id is unknown until the mapper writes the row. The mapper rewrites the sentinel post-save before the publisher (task-05) emits. The doc deliverable explains this — it is the same dance the legacy `Order.applyInventoryConfirmation` did pre-deletion (ADR-013).
- `assignCustomerId(...)` is the guest-cart-promotion hook. Task-05's `AddToCartUseCase` calls it when the bearer header carries a customer id but the loaded cart has `customerId === null` (the cookie-only path). The promotion is idempotent — calling it twice with the same id is a no-op.

## CartLine entity shape

```ts
import { Entity } from '@retail-inventory-system/ddd';

export interface ICartLineProps {
  cartId: string;
  variantId: number;
  quantity: number;
  unitPriceSnapshotMinor: number;
  currencySnapshot: string;
  createdAt: Date;
  updatedAt: Date;
}

export class CartLine extends Entity<number | null> {
  private constructor(id: number | null, private props: ICartLineProps) {
    super(id);
  }

  public static create(payload: {
    cartId?: string; // mapper fills this from the parent if undefined
    variantId: number;
    quantity: number;
    unitPriceSnapshotMinor: number;
    currencySnapshot: string;
  }): CartLine {
    if (payload.quantity <= 0) throw new Error('quantity must be > 0');
    if (payload.unitPriceSnapshotMinor < 0) throw new Error('unitPriceSnapshotMinor must be ≥ 0');
    if (!/^[A-Z]{3}$/.test(payload.currencySnapshot)) {
      throw new Error('currencySnapshot must be ISO 4217');
    }
    const now = new Date();
    return new CartLine(null, {
      cartId: payload.cartId ?? '',
      variantId: payload.variantId,
      quantity: payload.quantity,
      unitPriceSnapshotMinor: payload.unitPriceSnapshotMinor,
      currencySnapshot: payload.currencySnapshot,
      createdAt: now,
      updatedAt: now,
    });
  }

  public static rehydrate(id: number, props: ICartLineProps): CartLine {
    return new CartLine(id, props);
  }

  public setQuantity(newQuantity: number): void {
    if (newQuantity <= 0) throw new Error('quantity must be > 0');
    this.props.quantity = newQuantity;
    this.props.updatedAt = new Date();
  }

  public get cartId(): string { return this.props.cartId; }
  public get variantId(): number { return this.props.variantId; }
  public get quantity(): number { return this.props.quantity; }
  public get unitPriceSnapshotMinor(): number { return this.props.unitPriceSnapshotMinor; }
  public get currencySnapshot(): string { return this.props.currencySnapshot; }
  public get createdAt(): Date { return this.props.createdAt; }
  public get updatedAt(): Date { return this.props.updatedAt; }
}
```

## Repository shape

```ts
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Cart } from '../../domain';
import { ICartRepositoryPort } from '../../application/ports';
import { CartEntity } from './cart.entity';
import { CartMapper } from './cart.mapper';

@Injectable()
export class CartTypeormRepository
  extends BaseTypeormRepository<CartEntity, Cart>
  implements ICartRepositoryPort
{
  constructor(
    @InjectRepository(CartEntity) repository: Repository<CartEntity>,
    @InjectPinoLogger(CartTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {
    super(repository, new CartMapper());
  }

  public async findById(id: string): Promise<Cart | null> {
    const entity = await this.repository.findOne({ where: { id }, relations: ['lines'] });
    return entity ? this.mapper.toDomain(entity) : null;
  }

  public async findActiveByCustomerId(customerId: string): Promise<Cart | null> {
    const entity = await this.repository.findOne({
      where: { customerId, status: 'active' as const },
      relations: ['lines'],
    });
    return entity ? this.mapper.toDomain(entity) : null;
  }

  public async save(cart: Cart): Promise<Cart> {
    const entity = this.mapper.toEntity(cart);
    const saved = await this.repository.save(entity);
    return this.mapper.toDomain(saved);
  }
}
```

Three notes for the implementer:

- The `BaseTypeormRepository`'s string-id semantics need verification. The project's current `BaseTypeormRepository` is typed against the `BaseEntity` (int auto-increment id). If the base class assumes `number`, override `findById` to bypass the base helper rather than work around the typing — the override is shown above.
- The mapper translates `Cart` ↔ `CartEntity` and the lines together. The `toEntity` path projects the aggregate's `lines: readonly CartLine[]` into `CartLineEntity[]` and assigns them to the relation. TypeORM will then cascade-save the lines as part of the parent save (verify via `@OneToMany(..., { cascade: ['insert', 'update'] })` on the `CartEntity.lines` relation).
- After save, the mapper-driven re-hydration rewrites any `-1` sentinel `lineId`s in the aggregate's recorded events with the real DB ids. Task-05's `AddToCartUseCase` reads `cart.pullDomainEvents()` post-save and publishes them; this task's domain layer ships the sentinel mechanism and the repository ships the post-save rewrite step.

## Files to add

- `apps/retail-microservice/src/modules/cart/domain/cart.model.ts`
- `apps/retail-microservice/src/modules/cart/domain/cart-line.model.ts`
- `apps/retail-microservice/src/modules/cart/domain/cart-status.enum.ts`
- `apps/retail-microservice/src/modules/cart/domain/events/cart-created.event.ts`
- `apps/retail-microservice/src/modules/cart/domain/events/cart-line-added.event.ts`
- `apps/retail-microservice/src/modules/cart/domain/events/cart-line-removed.event.ts`
- `apps/retail-microservice/src/modules/cart/domain/events/cart-line-quantity-changed.event.ts`
- `apps/retail-microservice/src/modules/cart/domain/events/index.ts`
- `apps/retail-microservice/src/modules/cart/domain/index.ts`
- `apps/retail-microservice/src/modules/cart/domain/spec/cart.model.spec.ts`
- `apps/retail-microservice/src/modules/cart/domain/spec/cart-line.model.spec.ts`
- `apps/retail-microservice/src/modules/cart/application/ports/cart.repository.port.ts`
- `apps/retail-microservice/src/modules/cart/application/ports/index.ts`
- `apps/retail-microservice/src/modules/cart/infrastructure/persistence/cart.entity.ts`
- `apps/retail-microservice/src/modules/cart/infrastructure/persistence/cart-line.entity.ts`
- `apps/retail-microservice/src/modules/cart/infrastructure/persistence/cart.mapper.ts`
- `apps/retail-microservice/src/modules/cart/infrastructure/persistence/cart-line.mapper.ts` (or fold into `cart.mapper.ts` if the project convention prefers one file per aggregate; verify against `apps/retail-microservice/src/modules/orders/infrastructure/persistence/` pre-deletion patterns)
- `apps/retail-microservice/src/modules/cart/infrastructure/persistence/cart-typeorm.repository.ts`
- `apps/retail-microservice/src/modules/cart/infrastructure/persistence/index.ts`
- `apps/retail-microservice/src/modules/cart/infrastructure/cart.module.ts`
- `migrations/<timestamp>-CreateCartAndCartLineTables.ts`
- `libs/contracts/retail/cart/cart-status.enum.ts`
- `libs/contracts/retail/cart/events/cart-created.event.ts`
- `libs/contracts/retail/cart/events/cart-line-added.event.ts`
- `libs/contracts/retail/cart/events/cart-line-removed.event.ts`
- `libs/contracts/retail/cart/events/cart-line-quantity-changed.event.ts`
- `libs/contracts/retail/cart/events/index.ts`
- `libs/contracts/retail/cart/index.ts`
- `docs/implementation/05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md` (intro half)

## Files to modify

- `apps/retail-microservice/src/app/app.module.ts` — add `CartModule` to `imports`.
- `libs/contracts/retail/index.ts` — re-export from `cart/`.

## Tests

- `cart.model.spec.ts` — ≥7 cases: `Cart.create` records `CartCreatedEvent`; non-positive quantity on `addLine` rejected; non-matching currency on `addLine` rejected; adding the same variant twice merges quantities (single event); `removeLine` records `CartLineRemovedEvent`; `removeLine` on non-existent line rejects; `changeLineQuantity` to same value is a no-op (no event recorded); `markConverted` from non-active state rejects; `markConverted` from active succeeds and bumps version.
- `cart-line.model.spec.ts` — ≥4 cases: non-positive quantity rejected at `create`; negative `unitPriceSnapshotMinor` rejected; non-ISO `currencySnapshot` rejected; `setQuantity` updates `updatedAt`.
- The repository spec is **NOT** added here — the task-05 spec covers the repository via the in-memory test double, and the live TypeORM path is exercised by the task-12 e2e test (`cart-to-order-walking-skeleton.e2e-spec.ts`). The project's convention (verified against `apps/inventory-microservice/.../infrastructure/persistence/spec/`) is repository specs only where the SQL is non-trivial; the cart repository's three methods are straightforward and not worth a unit harness.
- `yarn lint` passes.
- `yarn build:retail-microservice` succeeds.
- `yarn migration:run` after `docker compose up -d` creates the two tables; `mysql -e "DESC cart"` shows the version column and the customer_id+status index; `mysql -e "DESC cart_line"` shows the cart_id FK.

## Doc deliverable

Write `docs/implementation/05-cart-order-payment-walking-skeleton/02-cart-aggregate-and-q1-q3-decisions.md` (intro half — target ~110 lines now; task-05 appends the use-case half). Sections this task writes:

1. **Q1 — When is a Cart persistent?** Restate the epic's decision: persistent for authenticated customers; ephemeral session-id-keyed for guests, promoted on first login or on Place Order. The cart row has a nullable `customer_id`; pre-promotion the cart resolves by id only (the cookie carries the cart's UUID). Forward-link to task-05's `AddToCartUseCase` doc which wires the promotion path.
2. **Q3 — Cart vs Order are distinct aggregates.** Restate: one-shot conversion at Place Order time. The conversion is `cart.markConverted()` + `Order.create(...)` in one transaction (task-06). No "Order edits the cart" path exists — once converted, the cart is read-only.
3. **The Cart aggregate's invariants.** The four invariants documented above: non-active carts cannot mutate; currency immutable post-create; adding-same-variant merges; `markConverted` only from active. Plus the version-bump-per-mutation contract that lets `epic-12`'s OCC retrofit be non-destructive.
4. **The `-1` lineId sentinel.** Why the event payload carries `-1` for newly-added lines until post-save, when the mapper rewrites it. The alternative — emitting events post-save inside the repository — was rejected because it couples the repository to the publisher port (the repository would have to know about `cart.pullDomainEvents()`). Cite the precedent: the legacy `Order.applyInventoryConfirmation` did the same dance pre-deletion (ADR-013).
5. **The cart_line.cart_id FK and ON DELETE CASCADE.** The cart is purgable (after `status='abandoned'` a sweep deletes it, per `epic-12`); lines go with it. Order_line is forbidden from `ON DELETE CASCADE` (epic-03 — orders are append-only); cart_line is allowed because the cart was never the system-of-record once conversion ran.
6. **The version column.** Forward-looking: ships now as `@VersionColumn()` so `epic-12`'s OCC retrofit is one annotation change in the repository, not a schema migration. The aggregate's per-mutation bump is therefore preserved end-to-end from day one.
7. **Forward links.** Task-05 (the five use cases that consume this aggregate); task-06 (Place Order's one-shot conversion); `epic-12` (idempotency-key dedupe + OCC enforcement).

Task-05 appends the use-case-flow half: how each use case mutates the aggregate, the catalog RPC for the price snapshot, the guest-cart promotion path.

## Carryover produced (consumed by task-03 onward)

- New `apps/retail-microservice/src/modules/cart/` folder with `domain/`, `application/ports/`, `infrastructure/persistence/`, `infrastructure/cart.module.ts` populated.
- `cart` + `cart_line` tables exist in MySQL after `yarn migration:run`.
- `ICartRepositoryPort` + `CART_REPOSITORY` symbol available — task-05's use cases inject them.
- `libs/contracts/retail/cart/` event interfaces available — task-05's publisher port and the notification-side subscriber (currently no consumer for cart events; future `epic-10`) have a typed surface.
- `Cart` + `CartLine` domain models on disk with their specs green.
- Doc `02-cart-aggregate-and-q1-q3-decisions.md` exists with the intro-half written.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `cart.model.spec.ts` (≥7 cases) and `cart-line.model.spec.ts` (≥4 cases) green.
- [ ] `yarn build:retail-microservice` succeeds.
- [ ] `docker compose up -d && yarn migration:run` creates `cart` (with `version` column + `(customer_id, status)` index + `expires_at` index) and `cart_line` (with `cart_id` FK ON DELETE CASCADE) tables.
- [ ] `git ls-files apps/retail-microservice/src/modules/cart/` shows the folder structure above.
- [ ] `git ls-files libs/contracts/retail/cart/` shows the event interfaces.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `02-cart-aggregate-and-q1-q3-decisions.md` exists with the seven sections above filled.
