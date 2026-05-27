---
epic: epic-05
task_number: 8
title: Implement Get Order + List My Orders use cases + endpoints
depends_on: [01, 02, 03, 04, 05, 06, 07]
doc_deliverable: (no new doc; cross-referenced from 03-order-three-status-and-q4-decision.md and 07-authorize-on-place-capture-explicit-q5.md)
---

# Task 08 — Implement Get Order + List My Orders use cases + endpoints

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** [ADR-010](../../docs/adr/010-jwt-rbac-at-the-gateway.md) (owner-check vs admin-permission pattern — the same shape applies here; this epic adds the `customer:own-orders:read` permission code that the api-gateway side (task-09) will enforce, and the use case repeats the check defense-in-depth), [ADR-013](../../docs/adr/013-order-aggregate-and-cross-service-confirm.md) (the previous Get Order path — note the simpler response shape; the new GET Order returns an `IOrderResponseDto` with payment summary + addresses inline), [ADR-019](../../docs/adr/019-typeorm-and-mysql-for-persistence.md) (the index on `order(customer_id, placed_at DESC)` from task-03 backs the `ListMyOrders` query).

## Goal

Land the two read use cases:

- `GetOrderUseCase` — fetch an order by id; owner-check (customer's own order) OR admin permission `order:read`; returns `IOrderResponseDto` with lines, payment summary, and the two addresses inlined.
- `ListMyOrdersUseCase` — paginated list of the authenticated customer's orders; admins cannot use this endpoint to browse other customers' orders (the epic explicitly says "customer; lists own only" — admins go through a separate admin-side endpoint that this epic does not ship; `epic-08`/`epic-09` ship the admin browse).

Both use cases are read-only. No event emission. No transaction (single-statement reads). The repository's `findById` (task-03) returns the order with lines populated; `listByCustomer` (still throwing-stub today) is implemented here against the `order(customer_id, placed_at DESC)` index from task-03.

This task also implements the auxiliary repository method on `IPaymentRepositoryPort.findByOrderId` (task-04 declared it; this task verifies and exercises it), and adds a `findAllByOrderIds(orderIds: number[])` for the list-my-orders batched payment-summary lookup.

## Entry state assumed

Task-07 carryover present:

- `Order.markPaymentCaptured()` exists; orders can be in `paymentStatus=captured`.
- `OrderRabbitmqPublisher.emitPaymentCaptured` works.

Task-06 carryover present:

- `IOrderResponseDto`, `IOrderLineDto`, `IAddressDto`, `IPaymentSummaryDto` defined.
- `PlaceOrderUseCase` produces orders.

Task-03 carryover present:

- `OrderTypeormRepository.findById` real; `findByOrderNumber` real; `listByCustomer` is the throwing stub.
- `order(customer_id, placed_at DESC)` index exists.

## Scope

**In:**

- New use case `apps/retail-microservice/src/modules/orders/application/use-cases/get-order.use-case.ts` + spec.
- New use case `apps/retail-microservice/src/modules/orders/application/use-cases/list-my-orders.use-case.ts` + spec.
- Promote `OrderTypeormRepository.listByCustomer` from throwing-stub to real implementation. Sort by `placed_at DESC`; page-window via `OFFSET/LIMIT` (verify against the project's existing pagination conventions in `libs/common/types/`); return `IPage<Order>` shape.
- Delete the `RetailRepositoryStubError` class (which task-03 moved to `errors/`) since no methods reference it anymore. Update `infrastructure/persistence/index.ts` accordingly.
- Add `findAllByOrderIds(orderIds: number[])` to `IPaymentRepositoryPort`, implemented in `PaymentTypeormRepository`. The query uses a `WHERE order_id IN (...)` with the `order_id` index (task-04 should have a non-unique index on `payment.order_id`; if not, this task adds the migration alongside — verify and if needed, ship a small `migrations/<ts>-AddPaymentOrderIdIndex.ts`).
- Update `AddressTypeormRepository` with `findAllByIds(ids: string[])` — used by both use cases to batch-fetch the addresses for the response DTO. Add the method to the port interface.
- Add `IListMyOrdersRequest` and `IListMyOrdersResponse` (paginated wrapper) to `libs/contracts/retail/orders/dto/`:
  ```ts
  export interface IListMyOrdersRequest {
    pageNumber?: number; // 1-based; default 1
    pageSize?: number;   // default 20, max 100
    currentUser: ICurrentUser;
    correlationId?: string;
  }
  export interface IListMyOrdersResponse {
    items: IOrderResponseDto[];
    page: { pageNumber: number; pageSize: number; total: number };
  }
  ```
- Add `IGetOrderRequest` to `libs/contracts/retail/orders/dto/`:
  ```ts
  export interface IGetOrderRequest {
    orderId: number;
    currentUser: ICurrentUser;
    correlationId?: string;
  }
  ```
- Add the two new presentation handlers on `OrdersController`:
  - `@MessagePattern(ROUTING_KEYS.RETAIL_ORDER_GET)` — new RPC constant `'retail.order.get'` (this is a re-introduction of the old key string — but as a fresh constant with the new payload shape; the legacy `RETAIL_ORDER_GET` constant was removed by task-01, so the symbol is free). The constant is added to `libs/messaging/routing-keys.constants.ts` + the enum mirror.
  - `@MessagePattern(ROUTING_KEYS.RETAIL_ORDER_LIST_MINE)` — new RPC constant `'retail.order.list-mine'`. Added to the constants + enum.
- Update `OrdersController` constructor to inject `GetOrderUseCase` + `ListMyOrdersUseCase`.
- Update `orders.module.ts` provider list with the two new use cases.

**Out:**

- The api-gateway-side `GET /api/orders/:id` and `GET /api/orders` — task-09.
- The admin-side browse-any-order endpoint — `epic-08`/`epic-09`.
- The cache wrapper on order reads — deferred (the epic notes that order reads are not cached today; ADR-016's `ris:retail:order:v1:<orderId>` builder exists but no read path goes through it yet).

## `GetOrderUseCase` shape

```ts
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICurrentUser,
  IGetOrderRequest,
  IOrderResponseDto,
} from '@retail-inventory-system/contracts';

import {
  ADDRESS_REPOSITORY,
  IAddressRepositoryPort,
  IOrderRepositoryPort,
  IPaymentRepositoryPort,
  ORDER_REPOSITORY,
  PAYMENT_REPOSITORY,
} from '../ports';

@Injectable()
export class GetOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepositoryPort,
    @Inject(ADDRESS_REPOSITORY) private readonly addresses: IAddressRepositoryPort,
    @InjectPinoLogger(GetOrderUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IGetOrderRequest): Promise<IOrderResponseDto> {
    const order = await this.orders.findById(payload.orderId);
    if (!order) throw new Error(`Order ${payload.orderId} not found`);
    this.assertCanRead(order, payload.currentUser);

    const [payment, addresses] = await Promise.all([
      this.payments.findByOrderId(order.id!),
      this.addresses.findAllByIds([order.billingAddressId, order.shippingAddressId]),
    ]);

    this.logger.info(
      { correlationId: payload.correlationId, orderId: order.id, by: payload.currentUser.id },
      'Order read',
    );

    return this.toResponseDto(order, payment, addresses);
  }

  private assertCanRead(order: { customerId: string }, user: ICurrentUser): void {
    const isAdmin =
      user.roles?.includes('admin') ||
      user.permissions?.includes('order:read');
    if (isAdmin) return;
    if (order.customerId !== user.id) {
      throw new Error('You may only read your own orders');
    }
  }

  private toResponseDto(/* order, payment, addresses */): IOrderResponseDto { /* … */ }
}
```

## `ListMyOrdersUseCase` shape

```ts
@Injectable()
export class ListMyOrdersUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepositoryPort,
    @Inject(ADDRESS_REPOSITORY) private readonly addresses: IAddressRepositoryPort,
    @InjectPinoLogger(ListMyOrdersUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IListMyOrdersRequest): Promise<IListMyOrdersResponse> {
    const pageNumber = Math.max(1, payload.pageNumber ?? 1);
    const pageSize = Math.min(100, Math.max(1, payload.pageSize ?? 20));

    const page = await this.orders.listByCustomer(
      payload.currentUser.id,
      { pageNumber, pageSize },
    );
    // Batch-fetch payments + addresses for the page.
    const orderIds = page.items.map((o) => o.id!);
    const addressIds = page.items.flatMap((o) => [o.billingAddressId, o.shippingAddressId]);
    const [payments, addresses] = await Promise.all([
      orderIds.length > 0 ? this.payments.findAllByOrderIds(orderIds) : Promise.resolve([]),
      addressIds.length > 0 ? this.addresses.findAllByIds(addressIds) : Promise.resolve([]),
    ]);
    const paymentsByOrderId = new Map(payments.map((p) => [p.orderId, p]));
    const addressesById = new Map(addresses.map((a) => [a.id, a]));

    this.logger.info(
      {
        correlationId: payload.correlationId,
        customerId: payload.currentUser.id,
        pageNumber,
        pageSize,
        returned: page.items.length,
        total: page.total,
      },
      'List my orders',
    );

    return {
      items: page.items.map((o) => this.toResponseDto(o, paymentsByOrderId.get(o.id!), addressesById)),
      page: { pageNumber, pageSize, total: page.total },
    };
  }
  // ...toResponseDto omitted.
}
```

Notes:

- The use case enforces `pageSize ≤ 100` defensively. The api-gateway DTO pipe (task-09) does the same check via `class-validator`; the use case's clamp is defense-in-depth.
- A customer with zero orders gets `items: [], page: { ..., total: 0 }` — not a rejection. The empty case is asserted in the spec.
- The use case batch-fetches payments and addresses — N orders produce 3 queries total (list + payments + addresses), not 1 + 2N. The doc note in `03-order-three-status-and-q4-decision.md` (task-03) on the `order(customer_id, placed_at DESC)` index supports the listByCustomer query path; this task verifies via `EXPLAIN` in local-dev that the index is used.

## Files to add

- `apps/retail-microservice/src/modules/orders/application/use-cases/get-order.use-case.ts`
- `apps/retail-microservice/src/modules/orders/application/use-cases/list-my-orders.use-case.ts`
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/get-order.use-case.spec.ts`
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/list-my-orders.use-case.spec.ts`
- `libs/contracts/retail/orders/dto/get-order-request.dto.ts`
- `libs/contracts/retail/orders/dto/list-my-orders-request.dto.ts`
- `libs/contracts/retail/orders/dto/list-my-orders-response.dto.ts`
- (Optional) `migrations/<ts>-AddPaymentOrderIdIndex.ts` if task-04 did not already ship the index — verify before adding.

## Files to modify

- `apps/retail-microservice/src/modules/orders/application/use-cases/index.ts` — re-export the two new use cases.
- `apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts` — provider list extended.
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-typeorm.repository.ts` — `listByCustomer` real (no longer throws). Remove the import of `RetailRepositoryStubError`; delete the `errors/retail-repository-stub.error.ts` file if no other references remain (the `addresses-typeorm.repository.ts` does not use it).
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/payment-typeorm.repository.ts` — add `findAllByOrderIds`.
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/address-typeorm.repository.ts` — add `findAllByIds`.
- `apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts` — `listByCustomer` signature finalized.
- `apps/retail-microservice/src/modules/orders/application/ports/payment.repository.port.ts` — add `findAllByOrderIds`.
- `apps/retail-microservice/src/modules/orders/application/ports/address.repository.port.ts` — add `findAllByIds`.
- `apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts` — add the two new `@MessagePattern` handlers.
- `libs/messaging/routing-keys.constants.ts` — add `RETAIL_ORDER_GET`, `RETAIL_ORDER_LIST_MINE` (note: the legacy `RETAIL_ORDER_GET` constant was removed by task-01; the new `RETAIL_ORDER_GET = 'retail.order.get'` here is a fresh constant — same routing-key string, new payload shape).
- `libs/messaging/spec/routing-keys.constants.spec.ts` — update assertions.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts` — add the two new entries.
- `libs/contracts/retail/orders/index.ts` — re-export the new DTOs.

## Tests

- `get-order.use-case.spec.ts` — ≥6 cases:
  1. Happy path: returns `IOrderResponseDto` with lines + payment + two addresses populated.
  2. Non-existent order rejects.
  3. Cross-customer non-admin rejects.
  4. Admin user can read any order.
  5. `order:read` permission grants read access regardless of ownership.
  6. The response includes the captured payment if `paymentStatus=captured`.
- `list-my-orders.use-case.spec.ts` — ≥6 cases:
  1. Customer with no orders returns `{ items: [], page: { total: 0 } }`.
  2. Customer with three orders sees them in `placed_at DESC` order.
  3. Pagination: `pageNumber=2, pageSize=2` returns items 3+ for a 5-order customer.
  4. `pageSize` clamped at 100.
  5. Customer can never see another customer's orders (the repository's WHERE clause filters; the use case does not need its own owner-check, but the spec asserts the repository call is scoped to `customerId`).
  6. The response includes the payment summary for each order (batch-fetched).
- The repository specs are exercised by the e2e tests in task-12. No new unit spec for the repository is needed.
- `yarn lint` passes.
- `yarn build:retail-microservice` succeeds.

## Doc deliverable

This task does NOT own a topic-numbered doc. The forward-reads behavior is documented inline in `03-order-three-status-and-q4-decision.md` (task-03's "What the next epics inherit" section forward-links to the read paths) and in `07-authorize-on-place-capture-explicit-q5.md` (task-07's mention of the explicit-capture endpoint implies a read endpoint to surface the captured Payment).

If the implementer finds the read-path is non-obvious enough to deserve its own paragraph, append a small "Read paths" section to `03-…md` at the end. The task-12 final-pass on `03-…md` is the last opportunity to add this.

## Carryover produced (consumed by task-09 onward)

- `GetOrderUseCase` and `ListMyOrdersUseCase` on disk + specs green.
- Two new routing-key constants (`RETAIL_ORDER_GET`, `RETAIL_ORDER_LIST_MINE`).
- `OrdersController` has all four handlers: `RETAIL_ORDER_PLACE` (task-06), `RETAIL_ORDER_CAPTURE` (task-07), `RETAIL_ORDER_GET` (this task), `RETAIL_ORDER_LIST_MINE` (this task).
- `OrderTypeormRepository.listByCustomer` real (no more throwing stub).
- `PaymentTypeormRepository.findAllByOrderIds` real.
- `AddressTypeormRepository.findAllByIds` real.
- The two new wire DTOs.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the two new specs (≥12 cases total) green.
- [ ] `yarn build:retail-microservice` succeeds.
- [ ] `yarn start:dev:retail-microservice` boots; a `rabbitmqadmin publish` against `retail.order.get` with a placed-order id returns an `IOrderResponseDto`; a publish against `retail.order.list-mine` returns the paginated wrapper.
- [ ] No throwing-stub method remains on `OrderTypeormRepository` (the class extends `IOrderRepositoryPort` with all methods real). The `errors/retail-repository-stub.error.ts` file is deleted if no other code references it.
- [ ] No file outside `tmp/` references `tmp/`.
