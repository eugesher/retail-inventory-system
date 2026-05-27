---
epic: epic-05
task_number: 3
title: Add `order` + `order_line` + `address` tables, domain, persistence, mappers
depends_on: [01, 02]
doc_deliverable: docs/implementation/epic-05-cart-order-payment-walking-skeleton/03-order-three-status-and-q4-decision.md and 06-address-polymorphic-snapshot.md
---

# Task 03 — Add `order` + `order_line` + `address` domain and persistence

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** [ADR-013](../../docs/adr/013-order-aggregate-and-cross-service-confirm.md) (the previous Order aggregate that is being replaced — note the surface it exported that the new one preserves vs replaces), [ADR-004](../../docs/adr/004-adopt-hexagonal-architecture-per-service.md) (per-module hexagonal layout — the new aggregates land at `modules/orders/`), [ADR-005](../../docs/adr/005-split-shared-common-into-bounded-libs.md) (the `BaseEntity` extension policy + the snake-naming strategy), [ADR-019](../../docs/adr/019-typeorm-and-mysql-for-persistence.md) (`@VersionColumn()` semantics for the OCC retrofit-friendly column).

## Goal

Land the new `Order` aggregate + `OrderLine` snapshot entity + the polymorphic `Address` snapshot entity. This task ships the domain, the persistence layer, the new repository methods (un-stubbing `OrderTypeormRepository.save` and `findById` against the new aggregate; `listByCustomer` stays stubbed until task-08), and the migration. **No use cases yet** — task-06 builds `PlaceOrderUseCase` (which is the first writer) and task-08 builds the two readers.

This task also lands `Address` as a separate top-level domain object under `modules/orders/domain/` because Address is owned by orders in this epic (the legacy customer-side address book is gone — see task-01's deletion of `customer.entity.ts`). The polymorphic shape (`owner_type ∈ {customer, order}`, `owner_id` varchar) is shipped now so the future customer address-book reintroduction (likely in a later epic) only needs to flip on a new `owner_type='customer'` row — no schema change required.

The Order aggregate carries three orthogonal status fields per Open Question Q4:

- `status: 'pending' | 'confirmed' | 'cancelled' | 'shipped' | 'delivered'` — the workflow-level status (this epic only ever sees `pending`; `confirmed` arrives when the Authorize step is reframed in `epic-08`; `cancelled` in `epic-08`/`epic-09`; `shipped`/`delivered` in `epic-08`).
- `paymentStatus: 'none' | 'authorized' | 'captured' | 'refunded' | 'failed'` — the payment-side status (this epic sets `authorized` at Place; `captured` at Capture; `refunded` is `epic-09`; `failed` arrives whenever the gateway returns a non-success result — wired in task-06 against the `FakePaymentGatewayAdapter` from task-04, where the fake always returns success today).
- `fulfillmentStatus: 'unfulfilled' | 'partially-shipped' | 'shipped' | 'delivered'` — the fulfillment-side status (this epic sets `unfulfilled` at Place; the other transitions are `epic-08`).

The domain has no constraints linking the three together — they evolve independently. `paymentStatus=captured` while `fulfillmentStatus=unfulfilled` is a valid state today and a common one (the customer paid, the warehouse hasn't shipped yet). The spec explicitly tests this independence.

## Entry state assumed

Task-02 carryover present:

- The `cart` + `cart_line` tables exist; the `modules/cart/` folder is populated with domain + persistence + module.
- `OrderTypeormRepository` is still the throwing stub from task-01.
- The `modules/orders/domain/` and `modules/orders/infrastructure/persistence/` folders are empty (apart from the throwing-stub repository + the marker port).
- `libs/contracts/retail/` has the new `cart/` subarea from task-02 and nothing under `orders/` yet (the legacy DTOs survive but the new shapes are added in this task).

## Scope

**In:**

- New folder structure under `apps/retail-microservice/src/modules/orders/domain/`:
  - `order.model.ts` — the aggregate root (rebuilt; not a rename of the legacy `Order`).
  - `order-line.model.ts` — child entity (snapshot fields).
  - `address.model.ts` — polymorphic snapshot entity (note: NOT a value object — it has an `id` and is loaded by id; the polymorphism is in the `ownerType` + `ownerId` discriminator).
  - `order-status.enum.ts` — five values.
  - `payment-status.enum.ts` — five values (the Order's view; `Payment.status` is a separate enum in `domain/payment-status.enum.ts` from task-04 with overlapping values — the doc explains the deliberate mirror).
  - `fulfillment-status.enum.ts` — four values.
  - `order-line-status.enum.ts` — five values: `'allocated' | 'shipped' | 'partially-shipped' | 'cancelled' | 'returned'`. All new lines get `'allocated'` at Place per the epic's forward-compat sentinel rule.
  - `address-owner-type.enum.ts` — `'customer' | 'order'`.
  - `events/order-placed.event.ts` — payload `{ orderId, orderNumber, customerId, grandTotalMinor, currency, lineCount, eventVersion: 'v1' }`. Extends a domain-event base; the cross-service wire interface lives in `libs/contracts/retail/orders/events/` (see "Out" below — task-06 owns wire-side).
  - `events/order-cancelled.event.ts` — payload reserved; the producer lands in `epic-09`.
  - `spec/order.model.spec.ts`, `spec/order-line.model.spec.ts`, `spec/address.model.spec.ts` — unit tests.
  - `index.ts` — barrel exports.
- `application/ports/` updates:
  - `order.repository.port.ts` — promote from the task-01 marker to the real interface: `save(order: Order): Promise<Order>`, `findById(id: number): Promise<Order | null>`, `findByOrderNumber(orderNumber: string): Promise<Order | null>` (used by task-06 for the Idempotency-Key-free duplicate-place guard at minimum — see `epic-12` for the real dedupe), `listByCustomer(customerId: string, page: IPageRequest): Promise<IPage<Order>>` (task-08 implementation lands then).
  - new `address.repository.port.ts` — `save(address: Address): Promise<Address>`, `findById(id: string): Promise<Address | null>`.
  - `ADDRESS_REPOSITORY` DI symbol.
- `infrastructure/persistence/` updates:
  - `order.entity.ts` — PK is BIGINT auto-increment per epic. `order_number` is `VARCHAR(20) UNIQUE`. The three status columns are MySQL `ENUM(...)` per the project convention (`enum` TypeORM column type with the enum imported from domain). `subtotal_minor` / `tax_total_minor` / `discount_total_minor` / `shipping_total_minor` / `grand_total_minor` are `BIGINT NOT NULL DEFAULT 0`. `billing_address_id` + `shipping_address_id` are `CHAR(36)` FK to `address.id` (composite uniqueness not enforced — see §"FK shapes" below). `placed_at` is `TIMESTAMP NOT NULL`. `version` is `INT NOT NULL DEFAULT 0` (mapped via `@VersionColumn()`).
  - `order-line.entity.ts` — PK BIGINT. `order_id` FK to `order.id ON DELETE RESTRICT` (orders are append-only — orders never delete, so RESTRICT is theoretical here; the constraint is correct in intent). `sku` is `VARCHAR(64)`. `name_snapshot` is `VARCHAR(255)`. `variant_id` is INT. `quantity` is INT. `unit_price_minor` / `tax_amount_minor` / `discount_amount_minor` / `line_total_minor` are BIGINT.
  - `address.entity.ts` — PK is `CHAR(36)` UUID (same pattern as `cart`). `owner_type` is an enum column. `owner_id` is `VARCHAR(64)` (fits both the customer's gateway-id string and the order's BIGINT-as-string). `country` is `CHAR(2)`. Composite secondary index on `(owner_type, owner_id)`.
  - `order.mapper.ts`, `order-line.mapper.ts` (or one combined `order.mapper.ts`), `address.mapper.ts`.
  - `order-typeorm.repository.ts` — promoted from throwing-stub to real implementation for `save` + `findById`. `listByCustomer` keeps the throwing-stub method (task-08 fills it in). The `RetailRepositoryStubError` class moves to a sibling file `errors/retail-repository-stub.error.ts` so it can be referenced by the still-stubbed methods and the real methods don't pollute the file.
  - `address-typeorm.repository.ts` — new repository; extends `BaseTypeormRepository`.
  - `index.ts` updates.
- `infrastructure/orders.module.ts` updates:
  - `DatabaseModule.forFeature([OrderEntity, OrderLineEntity, AddressEntity])`.
  - Provider list adds `{ provide: ORDER_REPOSITORY, useClass: OrderTypeormRepository }, OrderTypeormRepository, { provide: ADDRESS_REPOSITORY, useClass: AddressTypeormRepository }, AddressTypeormRepository`.
  - `exports: [ORDER_REPOSITORY, ADDRESS_REPOSITORY]`.
- New migration `migrations/<timestamp>-CreateOrderOrderLineAddressTables.ts`:
  - Three tables, in dependency order: `address` first (no FKs), then `order` (FKs to address), then `order_line` (FK to order).
  - Indexes per the epic: unique index on `order.order_number`; index on `order(customer_id, placed_at DESC)`; index on `order_line(order_id)`; composite index on `address(owner_type, owner_id)`.
  - `@VersionColumn()`'s `version` column on `order`.
  - Down migration: drops in reverse order. Forward-only deploy policy still applies; the down is for local-dev `migration:revert`.
- `libs/contracts/retail/orders/` new subfolder:
  - `order-status.enum.ts`, `payment-status.enum.ts`, `fulfillment-status.enum.ts`, `order-line-status.enum.ts`, `address-owner-type.enum.ts` — mirror enums (task-06 + task-08 use them in the wire DTOs).
  - `dto/place-order-request.dto.ts` — reserved for task-06; this task ships an empty placeholder file so the barrel structure is in place.
  - `dto/order-response.dto.ts` — same — task-06 fills it in.
  - `dto/list-orders-query.dto.ts` — same — task-08 fills it in.
  - `events/order-placed.event.ts` — wire interface extending `ICorrelationPayload` + `occurredAt: string` (task-06 emits against this; this task ships the type so the publisher port (task-06) has a typed surface).
  - `events/order-cancelled.event.ts`, `events/order-confirmed.event.ts` — wire-reserved interfaces (no producer this epic; `epic-09` produces `order.cancelled`; `epic-08`'s ship trigger redefines `order.confirmed` semantics).
  - `index.ts` — barrel.
- Update `libs/contracts/retail/index.ts` to re-export from `orders/`.
- Doc deliverables `03-order-three-status-and-q4-decision.md` (entire file written here) and `06-address-polymorphic-snapshot.md` (entire file written here).

**Out:**

- The wire DTOs for Place Order / Order responses — task-06 + task-08.
- `Payment` aggregate + table — task-04.
- The `PAYMENT_GATEWAY` port — task-04.
- The order-events publisher (the emit side of `retail.order.placed`) — task-06.
- The list-by-customer real implementation — task-08.
- Registering new `retail.order.placed` routing key — task-06.

## `Order` aggregate shape

```ts
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { OrderLine } from './order-line.model';
import { OrderStatusEnum } from './order-status.enum';
import { PaymentStatusEnum } from './payment-status.enum';
import { FulfillmentStatusEnum } from './fulfillment-status.enum';
import { OrderPlacedEvent } from './events';

export interface IOrderProps {
  orderNumber: string;
  customerId: string;
  currency: string;
  status: OrderStatusEnum;
  paymentStatus: PaymentStatusEnum;
  fulfillmentStatus: FulfillmentStatusEnum;
  subtotalMinor: number;
  taxTotalMinor: number;
  discountTotalMinor: number;
  shippingTotalMinor: number;
  grandTotalMinor: number;
  billingAddressId: string;
  shippingAddressId: string;
  placedAt: Date;
  version: number;
  lines: OrderLine[];
  createdAt: Date;
  updatedAt: Date;
}

export class Order extends AggregateRoot<number | null> {
  private constructor(id: number | null, private props: IOrderProps) {
    super(id);
  }

  public static place(payload: {
    orderNumber: string;
    customerId: string;
    currency: string;
    billingAddressId: string;
    shippingAddressId: string;
    lines: OrderLine[]; // already snapshotted by the use case
  }): Order {
    if (payload.lines.length === 0) throw new Error('Cannot place an empty order');
    const allLinesShareCurrency = payload.lines.every(
      (l) => l.currencySnapshot === payload.currency,
    );
    if (!allLinesShareCurrency) {
      throw new Error('All lines must share the order currency');
    }

    const subtotalMinor = payload.lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
    const taxTotalMinor = payload.lines.reduce((sum, l) => sum + l.taxAmountMinor, 0);
    const discountTotalMinor = 0; // this epic
    const shippingTotalMinor = 0; // this epic
    const grandTotalMinor =
      subtotalMinor + taxTotalMinor + shippingTotalMinor - discountTotalMinor;

    const now = new Date();
    const order = new Order(null, {
      orderNumber: payload.orderNumber,
      customerId: payload.customerId,
      currency: payload.currency,
      status: OrderStatusEnum.Pending,
      paymentStatus: PaymentStatusEnum.None, // promoted to Authorized by markAuthorized after the gateway returns
      fulfillmentStatus: FulfillmentStatusEnum.Unfulfilled,
      subtotalMinor,
      taxTotalMinor,
      discountTotalMinor,
      shippingTotalMinor,
      grandTotalMinor,
      billingAddressId: payload.billingAddressId,
      shippingAddressId: payload.shippingAddressId,
      placedAt: now,
      version: 0,
      lines: payload.lines,
      createdAt: now,
      updatedAt: now,
    });
    // OrderPlacedEvent is recorded AFTER the repository round-trip in the use
    // case — see ADR-013 §"OrderCreated event is constructed after repository
    // round-trip assigns the id". The use case calls `order.markPlaced(id)`
    // after `save()` returns.
    return order;
  }

  public static rehydrate(id: number, props: IOrderProps): Order {
    return new Order(id, props);
  }

  public markPlaced(): void {
    if (this.id === null) {
      throw new Error('markPlaced requires the aggregate to have a DB-assigned id');
    }
    this.recordEvent(
      new OrderPlacedEvent({
        orderId: this.id,
        orderNumber: this.props.orderNumber,
        customerId: this.props.customerId,
        grandTotalMinor: this.props.grandTotalMinor,
        currency: this.props.currency,
        lineCount: this.props.lines.length,
      }),
    );
  }

  public markPaymentAuthorized(): void {
    if (this.props.paymentStatus !== PaymentStatusEnum.None) {
      throw new Error(
        `Cannot authorize payment from ${this.props.paymentStatus}; expected None`,
      );
    }
    this.props.paymentStatus = PaymentStatusEnum.Authorized;
    this.props.updatedAt = new Date();
    this.props.version += 1;
  }

  public markPaymentCaptured(): void {
    if (this.props.paymentStatus !== PaymentStatusEnum.Authorized) {
      throw new Error(
        `Cannot capture payment from ${this.props.paymentStatus}; expected Authorized`,
      );
    }
    this.props.paymentStatus = PaymentStatusEnum.Captured;
    this.props.updatedAt = new Date();
    this.props.version += 1;
  }

  public markPaymentFailed(): void {
    if (this.props.paymentStatus !== PaymentStatusEnum.None) {
      throw new Error(
        `Cannot mark payment failed from ${this.props.paymentStatus}; expected None`,
      );
    }
    this.props.paymentStatus = PaymentStatusEnum.Failed;
    this.props.updatedAt = new Date();
    this.props.version += 1;
  }

  // ...accessors omitted for brevity — every prop exposed read-only.
}
```

Notes:

- `Order.place(...)` does NOT record `OrderPlacedEvent`. The event is recorded by `markPlaced()` which the use case (task-06) calls after `save(...)` returns the DB-assigned id. This preserves the ADR-013 contract: events carrying the id are constructed only after the id exists.
- `markPaymentAuthorized()` / `markPaymentCaptured()` / `markPaymentFailed()` enforce the per-transition guards. The use cases (task-06 + task-07) call them; the gate is here in the aggregate so the spec covers the transition table exhaustively.
- Status transitions on `status` and `fulfillmentStatus` are not defined yet (this epic only writes Pending and Unfulfilled); task-08 in `epic-08` will add `markShipped` / `markDelivered` etc.

## `OrderLine` entity shape

```ts
import { Entity } from '@retail-inventory-system/ddd';

import { OrderLineStatusEnum } from './order-line-status.enum';

export interface IOrderLineProps {
  orderId: number | null; // null until the parent order is saved
  variantId: number;
  sku: string;
  nameSnapshot: string;
  quantity: number;
  unitPriceMinor: number;
  taxAmountMinor: number;
  discountAmountMinor: number;
  lineTotalMinor: number;
  currencySnapshot: string;
  status: OrderLineStatusEnum;
  createdAt: Date;
  updatedAt: Date;
}

export class OrderLine extends Entity<number | null> {
  private constructor(id: number | null, private props: IOrderLineProps) {
    super(id);
  }

  public static create(payload: {
    variantId: number;
    sku: string;
    nameSnapshot: string;
    quantity: number;
    unitPriceMinor: number;
    taxAmountMinor: number;
    currencySnapshot: string;
  }): OrderLine {
    if (payload.quantity <= 0) throw new Error('quantity must be > 0');
    if (payload.unitPriceMinor < 0) throw new Error('unitPriceMinor must be ≥ 0');
    if (payload.taxAmountMinor < 0) throw new Error('taxAmountMinor must be ≥ 0');
    if (!/^[A-Z]{3}$/.test(payload.currencySnapshot)) {
      throw new Error('currencySnapshot must be ISO 4217');
    }
    const lineTotalMinor = payload.unitPriceMinor * payload.quantity + payload.taxAmountMinor;
    const now = new Date();
    return new OrderLine(null, {
      orderId: null,
      variantId: payload.variantId,
      sku: payload.sku,
      nameSnapshot: payload.nameSnapshot,
      quantity: payload.quantity,
      unitPriceMinor: payload.unitPriceMinor,
      taxAmountMinor: payload.taxAmountMinor,
      discountAmountMinor: 0,
      lineTotalMinor,
      currencySnapshot: payload.currencySnapshot,
      status: OrderLineStatusEnum.Allocated,
      createdAt: now,
      updatedAt: now,
    });
  }

  public static rehydrate(id: number, props: IOrderLineProps): OrderLine {
    return new OrderLine(id, props);
  }

  // Snapshot fields are immutable post-creation — no setters.
  // The only mutator surface is `markStatus(...)` for future epics.

  public markStatus(newStatus: OrderLineStatusEnum): void {
    // Allowed transitions: allocated → shipped, allocated → cancelled, etc.
    // This epic only ever writes `allocated`. Real transition table is in
    // epic-08. For now: assert the transition is not "back to allocated".
    if (newStatus === OrderLineStatusEnum.Allocated && this.props.status !== OrderLineStatusEnum.Allocated) {
      throw new Error('Cannot revert OrderLine to Allocated');
    }
    this.props.status = newStatus;
    this.props.updatedAt = new Date();
  }

  // ...accessors omitted.
}
```

## `Address` entity shape

```ts
import { Entity } from '@retail-inventory-system/ddd';

import { AddressOwnerTypeEnum } from './address-owner-type.enum';

export interface IAddressProps {
  ownerType: AddressOwnerTypeEnum;
  ownerId: string;
  recipientName: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string; // 2-char ISO
  phone: string;
  createdAt: Date;
  updatedAt: Date;
}

export class Address extends Entity<string> {
  private constructor(id: string, private props: IAddressProps) {
    super(id);
  }

  public static create(payload: {
    id: string; // UUID generated by the use case
    ownerType: AddressOwnerTypeEnum;
    ownerId: string;
    recipientName: string;
    line1: string;
    line2?: string | null;
    city: string;
    region: string;
    postalCode: string;
    country: string;
    phone: string;
  }): Address {
    if (!/^[A-Z]{2}$/.test(payload.country)) {
      throw new Error('country must be 2-char ISO 3166-1 alpha-2');
    }
    if (payload.recipientName.trim().length === 0) {
      throw new Error('recipientName must be non-empty');
    }
    // line1/city/region/postalCode/phone — keep validation light per the
    // walking-skeleton scope. Address-format-by-country is epic-15.
    const now = new Date();
    return new Address(payload.id, {
      ownerType: payload.ownerType,
      ownerId: payload.ownerId,
      recipientName: payload.recipientName,
      line1: payload.line1,
      line2: payload.line2 ?? null,
      city: payload.city,
      region: payload.region,
      postalCode: payload.postalCode,
      country: payload.country,
      phone: payload.phone,
      createdAt: now,
      updatedAt: now,
    });
  }

  public static rehydrate(id: string, props: IAddressProps): Address {
    return new Address(id, props);
  }

  // Address is immutable post-create (snapshot semantics). No mutators.
  // ...accessors omitted.
}
```

## FK shapes

- `order.billing_address_id` and `order.shipping_address_id` are both `CHAR(36) NOT NULL` FK to `address.id`. They are **NOT** required to have `address.owner_type = 'order'` and `address.owner_id = order.id` — the polymorphic discriminator is informational (and used by the future customer-side address-book listing query). The application layer is responsible for setting `owner_type='order'` and `owner_id=<the new orderId-as-string>` correctly when it creates the addresses (task-06 does this). The composite index on `(owner_type, owner_id)` is what makes the listing query cheap.
- `order_line.order_id` is `BIGINT NOT NULL` FK to `order.id ON DELETE RESTRICT`. The RESTRICT is theoretical (orders are append-only), but documents intent.
- `cart.order_id` does **not exist** — the Q3 decision is that Cart does not parent the Order. The conversion link is one-directional: `Order` carries the customer id; the cart, post-conversion, holds `status='converted'` but is never read again by orders.

## Repository updates

```ts
@Injectable()
export class OrderTypeormRepository implements IOrderRepositoryPort {
  constructor(
    @InjectRepository(OrderEntity) private readonly repository: Repository<OrderEntity>,
    private readonly mapper: OrderMapper,
    @InjectPinoLogger(OrderTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {}

  public async save(order: Order): Promise<Order> {
    const entity = this.mapper.toEntity(order);
    const saved = await this.repository.save(entity);
    return this.mapper.toDomain(saved);
  }

  public async findById(id: number): Promise<Order | null> {
    const entity = await this.repository.findOne({ where: { id }, relations: ['lines'] });
    return entity ? this.mapper.toDomain(entity) : null;
  }

  public async findByOrderNumber(orderNumber: string): Promise<Order | null> {
    const entity = await this.repository.findOne({
      where: { orderNumber },
      relations: ['lines'],
    });
    return entity ? this.mapper.toDomain(entity) : null;
  }

  // Task-08 fills this in. Stub stays until then.
  public async listByCustomer(_customerId: string, _page: unknown): Promise<never> {
    throw new RetailRepositoryStubError('listByCustomer', 8);
  }
}
```

## Files to add

- `apps/retail-microservice/src/modules/orders/domain/order.model.ts`
- `apps/retail-microservice/src/modules/orders/domain/order-line.model.ts`
- `apps/retail-microservice/src/modules/orders/domain/address.model.ts`
- `apps/retail-microservice/src/modules/orders/domain/order-status.enum.ts`
- `apps/retail-microservice/src/modules/orders/domain/payment-status.enum.ts`
- `apps/retail-microservice/src/modules/orders/domain/fulfillment-status.enum.ts`
- `apps/retail-microservice/src/modules/orders/domain/order-line-status.enum.ts`
- `apps/retail-microservice/src/modules/orders/domain/address-owner-type.enum.ts`
- `apps/retail-microservice/src/modules/orders/domain/events/order-placed.event.ts`
- `apps/retail-microservice/src/modules/orders/domain/events/order-cancelled.event.ts`
- `apps/retail-microservice/src/modules/orders/domain/events/index.ts`
- `apps/retail-microservice/src/modules/orders/domain/index.ts`
- `apps/retail-microservice/src/modules/orders/domain/spec/order.model.spec.ts`
- `apps/retail-microservice/src/modules/orders/domain/spec/order-line.model.spec.ts`
- `apps/retail-microservice/src/modules/orders/domain/spec/address.model.spec.ts`
- `apps/retail-microservice/src/modules/orders/application/ports/address.repository.port.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order.entity.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-line.entity.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/address.entity.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order.mapper.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/address.mapper.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/address-typeorm.repository.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/errors/retail-repository-stub.error.ts` (relocated from task-01's repository file)
- `migrations/<timestamp>-CreateOrderOrderLineAddressTables.ts`
- `libs/contracts/retail/orders/order-status.enum.ts`
- `libs/contracts/retail/orders/payment-status.enum.ts`
- `libs/contracts/retail/orders/fulfillment-status.enum.ts`
- `libs/contracts/retail/orders/order-line-status.enum.ts`
- `libs/contracts/retail/orders/address-owner-type.enum.ts`
- `libs/contracts/retail/orders/events/order-placed.event.ts`
- `libs/contracts/retail/orders/events/order-cancelled.event.ts`
- `libs/contracts/retail/orders/events/order-confirmed.event.ts`
- `libs/contracts/retail/orders/events/index.ts`
- `libs/contracts/retail/orders/index.ts`
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/03-order-three-status-and-q4-decision.md`
- `docs/implementation/epic-05-cart-order-payment-walking-skeleton/06-address-polymorphic-snapshot.md`

## Files to modify

- `apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts` — promote from task-01 marker to the full interface.
- `apps/retail-microservice/src/modules/orders/application/ports/index.ts` — re-export the address port + the new `ADDRESS_REPOSITORY` symbol.
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-typeorm.repository.ts` — promote save/findById/findByOrderNumber to real implementations; `listByCustomer` stays stubbed.
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/index.ts` — barrel updates.
- `apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts` — `forFeature` with the three entities; provider list adds the address repository.
- `libs/contracts/retail/index.ts` — re-export from `orders/`.

## Tests

- `order.model.spec.ts` — ≥10 cases: place succeeds with one line; place rejects empty lines; place rejects mixed-currency lines; subtotal = sum of unitPrice * quantity; grandTotal = subtotal + tax + shipping − discount; markPlaced rejects when id is null; markPlaced records OrderPlacedEvent with correct payload; markPaymentAuthorized rejects if not None; markPaymentCaptured rejects if not Authorized; the three status fields evolve independently (paymentStatus=Captured + fulfillmentStatus=Unfulfilled is valid).
- `order-line.model.spec.ts` — ≥5 cases: snapshot fields immutable after create (no setters exist); positive quantity required; non-negative unitPrice / taxAmount; ISO-currency required; lineTotal computed correctly.
- `address.model.spec.ts` — ≥4 cases: 2-char ISO country enforced; non-empty recipientName required; line2 allowed null; create + rehydrate produce equivalent shapes.
- `yarn lint` passes.
- `yarn build:retail-microservice` succeeds.
- `yarn migration:run` creates the three tables.
- A boot smoke test: `yarn start:dev:retail-microservice` boots; the `order_typeorm.repository.findById` method now resolves to `null` for any id (the table is empty) rather than throwing the stub error.

## Doc deliverables

### `03-order-three-status-and-q4-decision.md` — written entirely by this task

Target ~140 lines. Sections:

1. **Q4 — three orthogonal status fields.** Restate: `status`, `paymentStatus`, `fulfillmentStatus` evolve independently. Why a single combined enum (the legacy shape — `pending`/`pending-payment`/`paid`/`shipped`/...) was rejected: every shipping-related status decision had to enumerate the cartesian product of payment × shipping, leading to combinatorial bloat and a hard time expressing things like "paid but not shipped". Three columns let each state machine document itself.
2. **State machines.** Three mermaid (or ASCII) state diagrams, one per status. For each diagram, note which epic's task is the writer for each transition. This epic writes `Pending` (status); `None → Authorized` and `Authorized → Captured` (paymentStatus, tasks 06 + 07); `Unfulfilled` (fulfillmentStatus, default at place). Mark which transitions are owned by `epic-08` (Ship/Deliver/Cancel-pre-fulfillment) and `epic-09` (Refund/Return).
3. **The aggregate's per-transition guards.** Cite `markPaymentAuthorized` rejecting from non-`None`; `markPaymentCaptured` rejecting from non-`Authorized`; `markPaymentFailed` mirroring `markPaymentAuthorized`. Why the guards live in the aggregate (testable in unit specs) and not in the use case.
4. **OrderLine snapshot fields are immutable.** Why `sku`, `nameSnapshot`, `unitPriceMinor` have no setters: the snapshot is the contract, not the catalog row at read time. Forward-link to doc 04 (task-06 writes) for the cross-service snapshot lookup at Place time.
5. **The `version` column.** Same forward-looking rationale as cart: `@VersionColumn()` ships now; OCC enforcement lands in `epic-12`. Per-mutation bumps are in the aggregate's mutator methods.
6. **What the next epics inherit.** Sketch the additions: `epic-08` adds `markShipped` / `markDelivered`; `epic-09` adds `markCancelled` / `markRefunded`. The current aggregate's surface is intentionally minimal so those additions are pure additions, not edits.

### `06-address-polymorphic-snapshot.md` — written entirely by this task

Target ~100 lines. Sections:

1. **Polymorphic by `(owner_type, owner_id)`.** Restate the epic's decision. `owner_type ∈ {'customer', 'order'}`. The customer-side address book is not used by this epic — every address row is `owner_type='order'`. The polymorphism is shipped now so the future customer address book is a fan-in row insert, not a schema migration.
2. **Snapshot, not reference.** Why the order's billing/shipping address is a copy of the data supplied at Place time, not a FK to the customer's address book entry: edits to the customer's address book must not retroactively change historical orders. The legal/audit requirement (`epic-06`'s Customer-PII tombstone-erase, Q6) needs this.
3. **The CHAR(36) UUID PK.** Why not BIGINT — to match the cart's PK pattern (a guest can't quote a BIGINT auto-increment cart id without a round trip; addresses inherit the same trade-off via consistency).
4. **The composite `(owner_type, owner_id)` index.** What query path it serves today (none — the address-book listing query is future), and what query path it will serve in the future customer epic.
5. **Validation.** ISO 3166-1 alpha-2 country check; non-empty recipient. Per-country format validation is `epic-15` (the address-format-by-country exclusion).
6. **Forward links.** Doc 04 (task-06's `PlaceOrderUseCase` Address snapshot path); future customer address-book epic.

## Carryover produced (consumed by task-04 onward)

- Three new tables (`order`, `order_line`, `address`) in MySQL.
- New domain models (`Order`, `OrderLine`, `Address`) + their enums + their specs green.
- `OrderTypeormRepository.save`, `findById`, `findByOrderNumber` real — `listByCustomer` still a throwing stub for task-08.
- `AddressTypeormRepository` real.
- `libs/contracts/retail/orders/` populated with the enums + the event wire interfaces.
- `orders.module.ts` has the address + order entities in `forFeature` and both repositories provided.
- Docs 03 + 06 written.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `order.model.spec.ts` (≥10), `order-line.model.spec.ts` (≥5), `address.model.spec.ts` (≥4) green.
- [ ] `yarn build:retail-microservice` succeeds.
- [ ] `yarn migration:run` creates `order`, `order_line`, `address`; `DESC order` shows the three status enum columns + the version column; `DESC address` shows the composite `(owner_type, owner_id)` index; `DESC order_line` shows the order_id FK.
- [ ] `yarn start:dev:retail-microservice` boots; the throwing stub's `listByCustomer` is the only method that still throws (verified by reading the repository file).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Docs `03-…md` (six sections) and `06-…md` (six sections) exist.
