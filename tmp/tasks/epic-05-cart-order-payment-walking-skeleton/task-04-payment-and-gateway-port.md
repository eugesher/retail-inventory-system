---
epic: epic-05
task_number: 4
title: Payment aggregate + PAYMENT_GATEWAY port + FakePaymentGatewayAdapter
depends_on: [1, 2, 3]
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/05-payment-gateway-port-and-fake-adapter.md
---

# Task 04 — Payment aggregate + PAYMENT_GATEWAY port + FakePaymentGatewayAdapter

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-028** (the `PAYMENT_GATEWAY` port + `FakePaymentGatewayAdapter`
seam; Payment lives **inside the `orders/` module**; authorize-on-place /
capture-explicit (Q5)), **ADR-011** (the `NotifierPort` precedent — a domain port
with a default adapter and scaffold alternatives; the adapter lives under
`infrastructure/`, the port under `application/ports/`), **ADR-004/ADR-017**
(framework-free domain; ports return domain types; `axios`/HTTP clients are
infrastructure-only — the fake adapter has none, but a real one later would), **ADR-019**
(extend `BaseEntity`; hand-authored migration; mysql2 BIGINTs as strings — coerce).

## Goal

Add the `Payment` aggregate (domain + persistence + repository) inside the retail
`orders/` module, and introduce the `PAYMENT_GATEWAY` port with its default
`FakePaymentGatewayAdapter` (always authorizes; deterministic fake tokens). **No use
cases and no gateway HTTP yet** — Authorize is wired into Place Order in task-06 and
Capture in task-07. This task lands the seam + the persistence + the adapter
contract conformance spec.

## Entry state assumed

- task-01–03 complete: legacy order model gone; `cart`/`cart_line`,
  `order`/`order_line`/`address` tables + their domain/persistence live; the retail
  `orders/` module exists with the Order/Address repositories; the order enums + view
  DTOs are in `libs/contracts/retail`; `Order.markPaymentAuthorized()` /
  `markPaymentCaptured()` exist on the aggregate.
- The `order` table exists (`payment.order_id` will FK to it).

## New domain model specifics

### `PaymentStatusEnum` (`libs/contracts/retail/enums/payment-status.enum.ts` — the
**payment-row** status, distinct from the order's `OrderPaymentStatusEnum` which has
a `none` member the row never has): `AUTHORIZED='authorized'`, `CAPTURED='captured'`,
`VOIDED='voided'`, `REFUNDED='refunded'`, `FAILED='failed'`.

### `Payment` (framework-free aggregate;
`apps/retail-microservice/src/modules/orders/domain/payment.model.ts`,
`extends AggregateRoot<number | null>`):
- Fields: `id: number | null`, `orderId: number`, `amountMinor: number`,
  `currency: string`, `method: string` (opaque token from the gateway),
  `status: PaymentStatusEnum`, `gatewayReference: string` (opaque),
  `authorizedAt: Date | null`, `capturedAt: Date | null`, `createdAt?`, `updatedAt?`.
- Invariants: `amountMinor` non-negative integer; `currency` non-empty; `orderId`
  positive; `gatewayReference`/`method` non-empty.
- `static authorized({ orderId, amountMinor, currency, method, gatewayReference,
  authorizedAt })` — the construction path from a successful authorize: `status =
  AUTHORIZED`, `capturedAt = null`.
- `static reconstitute(props)` — load path.
- `capture(at: Date)` — the **only** mutation: `AUTHORIZED → CAPTURED`, sets
  `capturedAt`. Rejects if not `AUTHORIZED`. (Void/refund/fail land with later
  capabilities — do **not** add them now.)

## PAYMENT_GATEWAY port + fake adapter

`IPaymentGatewayPort` (`PAYMENT_GATEWAY` symbol;
`apps/.../orders/application/ports/payment-gateway.port.ts`) — domain/contract types
only, **no transport/HTTP import**:

```ts
export interface IPaymentAuthorizeRequest {
  orderId: number;
  amountMinor: number;
  currency: string;
  method?: string;        // opaque method token from the caller (optional)
  correlationId?: string;
}
export interface IPaymentAuthorizeResult {
  approved: boolean;
  gatewayReference: string;
  method: string;
  authorizedAt: Date;
}
export interface IPaymentCaptureResult {
  captured: boolean;
  gatewayReference: string;
  capturedAt: Date;
}
export interface IPaymentGatewayPort {
  authorize(req: IPaymentAuthorizeRequest): Promise<IPaymentAuthorizeResult>;
  capture(gatewayReference: string, correlationId?: string): Promise<IPaymentCaptureResult>;
}
```

`FakePaymentGatewayAdapter`
(`apps/.../orders/infrastructure/payment-gateway/fake-payment-gateway.adapter.ts`)
implements `IPaymentGatewayPort`, **always approves**: `authorize` returns
`{ approved: true, gatewayReference: 'fake_' + randomUUID(), method: req.method ??
'fake-card', authorizedAt: new Date() }`; `capture` returns `{ captured: true,
gatewayReference, capturedAt: new Date() }`. No external calls, no persistence — it
is a deterministic in-process stand-in. Bind it as the default `PAYMENT_GATEWAY`
provider in `orders.module.ts`.

> Why the port-and-adapter split: a real gateway (Stripe/PayPal/etc.) is an excluded
> capability. Keeping authorize/capture behind a port means Place Order and Capture
> use cases (tasks 06/07) depend only on `IPaymentGatewayPort`; swapping in a real
> adapter later is a single provider rebinding with no use-case change. This mirrors
> the `NotifierPort` default-adapter pattern (ADR-011).

## Repository port

`IPaymentRepositoryPort` (`PAYMENT_REPOSITORY`;
`apps/.../orders/application/ports/payment.repository.port.ts`):

```ts
save(payment: Payment): Promise<Payment>;       // re-reads for the concrete id
findById(id: number): Promise<Payment | null>;
findByOrderId(orderId: number): Promise<Payment | null>;   // one payment per order in this capability
```

Implement `PaymentTypeormRepository` under `orders/infrastructure/persistence/`.

## Persistence specifics

`PaymentEntity extends BaseEntity` (generated `BIGINT` id). `order_id` is a plain
`BIGINT` FK to `order.id` (`@ManyToOne` optional — a plain column + FK is enough,
since Payment is its own aggregate root, not a child of Order). `status` is an ENUM
column; `authorized_at` / `captured_at` are nullable timestamps;
`gateway_reference` has a UNIQUE index. `deletedAt` inert (payments are append-only).

### Migration (`yarn migration:create`)

One migration, e.g. `…-CreatePaymentTable`, `synchronize` off:

```sql
-- up
CREATE TABLE payment (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id          BIGINT UNSIGNED NOT NULL,
  amount_minor      BIGINT       NOT NULL,
  currency          CHAR(3)      NOT NULL,
  method            VARCHAR(64)  NOT NULL,
  status            ENUM('authorized','captured','voided','refunded','failed') NOT NULL,
  gateway_reference VARCHAR(255) NOT NULL,
  authorized_at     TIMESTAMP    NULL,
  captured_at       TIMESTAMP    NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMP    NULL,
  CONSTRAINT UC_PAYMENT_GATEWAY_REFERENCE UNIQUE (gateway_reference),
  CONSTRAINT FK_PAYMENT_ORDER FOREIGN KEY (order_id)
    REFERENCES `order` (id) ON DELETE RESTRICT
);
CREATE INDEX IDX_PAYMENT_ORDER ON payment (order_id);
```

- `down` drops `payment`.

## Contracts (`libs/contracts/retail`)

- `enums/payment-status.enum.ts` (`PaymentStatusEnum`) + barrel.
- `dto/payment.view.ts` — `PaymentView` (`id`, `orderId`, `amountMinor`, `currency`,
  `method`, `status`, `gatewayReference`, `authorizedAt`, `capturedAt`). Class with
  `@ApiResponseProperty`. Wire the optional `payment?: PaymentView` field onto
  `OrderView` (added skeletally in task-03) now that `PaymentView` exists. Re-export
  from the retail barrels.

## Module wiring

In `orders.module.ts`: add `PaymentEntity` to `DatabaseModule.forFeature([...])` and
to the exported `orderEntities` barrel; provide `PaymentTypeormRepository` +
`{ provide: PAYMENT_REPOSITORY, useExisting: PaymentTypeormRepository }`; provide
`{ provide: PAYMENT_GATEWAY, useClass: FakePaymentGatewayAdapter }`. Register
`PaymentEntity` in retail `app.module.ts`'s `DatabaseModule.forRoot([...])`.

## Files to add

- `apps/.../orders/domain/payment.model.ts` (+ `spec/payment.model.spec.ts`)
- `apps/.../orders/application/ports/payment-gateway.port.ts`,
  `payment.repository.port.ts` (update the ports `index.ts`)
- `apps/.../orders/infrastructure/payment-gateway/fake-payment-gateway.adapter.ts`,
  `index.ts` (+ `spec/fake-payment-gateway.adapter.spec.ts`)
- `apps/.../orders/infrastructure/persistence/payment.entity.ts`, `payment.mapper.ts`,
  `payment-typeorm.repository.ts` (update the persistence `index.ts`)
- `libs/contracts/retail/enums/payment-status.enum.ts`
- `libs/contracts/retail/dto/payment.view.ts`
- `migrations/<timestamp>-CreatePaymentTable.ts`
- `docs/implementation/05-cart-order-payment-walking-skeleton/05-payment-gateway-port-and-fake-adapter.md`

## Files to modify

- `apps/.../orders/infrastructure/orders.module.ts` — register the payment entity,
  repository + port, and the `PAYMENT_GATEWAY → FakePaymentGatewayAdapter` binding.
- `apps/retail-microservice/src/app/app.module.ts` — register `PaymentEntity`.
- `libs/contracts/retail/{index,enums/index,dto/index}.ts`; `dto/order.view.ts`
  (add the optional `payment?: PaymentView`).
- `apps/.../orders/application/ports/index.ts`,
  `apps/.../orders/infrastructure/persistence/index.ts`.

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`):
  - `payment.model.spec.ts` — `authorized` factory yields `status=authorized`,
    `capturedAt=null`; `capture()` transitions `authorized → captured` and stamps
    `capturedAt`; `capture()` on a non-authorized payment is rejected; `amountMinor`
    non-negative.
  - `fake-payment-gateway.adapter.spec.ts` — **adapter contract conformance**:
    `authorize` returns `approved=true` with a non-empty `gatewayReference` + `method`
    + an `authorizedAt` Date; `capture(ref)` returns `captured=true` echoing the ref +
    a `capturedAt`; two `authorize` calls yield distinct `gatewayReference`s.
  - (Recommended) `payment-typeorm.repository.spec.ts` — `save` round-trips the
    concrete id; `findByOrderId` finds it.
- **Migration** — `yarn migration:run` creates `payment` (with the unique
  `gateway_reference` + FK to `order`); `revert` drops it; re-apply works.
- **E2E** — no new e2e (Authorize/Capture wire up in tasks 06/07); the full suite
  stays green.

## Doc deliverable

`05-payment-gateway-port-and-fake-adapter.md` — why the port-and-adapter split (a
real gateway is an excluded capability; the seam keeps use cases gateway-agnostic);
what the fake returns (always-authorize, deterministic fake tokens, no external
calls); the `Payment` aggregate + its single `capture` mutation; that Payment lives
**inside the `orders/` module** (it is part of the order/checkout context, its
operations touch the `Order` aggregate) rather than a standalone module; how a real
gateway swaps in later (rebind `PAYMENT_GATEWAY`, add an `infrastructure/payment-gateway/`
adapter that does HTTP, no use-case change) — the future real-gateway design sketch
is a later `docs/extensions/` concern, not linked here. Cross-link `docs/adr/028-…md`
and `docs/adr/011-…md`. Describe everything by capability — never by an epic/task
number.

## Carryover to read

`carryover-01.md` … `carryover-03.md`.

## Carryover to produce

Write `carryover-04.md`. Capture: the `Payment` model API (`authorized` factory,
`capture` mutation) + `PaymentStatusEnum`; the `IPaymentGatewayPort` shape
(`authorize`/`capture` + the request/result interfaces) + `PAYMENT_GATEWAY` symbol +
that `FakePaymentGatewayAdapter` is the bound default; `IPaymentRepositoryPort` +
`PAYMENT_REPOSITORY`; the `payment` schema (unique `gateway_reference`, FK to
`order`); the `PaymentView` contract + that `OrderView.payment?` now exists; that
Authorize/Capture **use cases do not exist yet**. Deferrals: Authorize-on-place →
task-06; Capture → task-07. List verify commands.

## Exit criteria

- [ ] `payment` exists with the documented columns, the unique `gateway_reference`,
      and the FK to `order`; the migration reverts + re-applies cleanly.
- [ ] `Payment` model + spec green; `FakePaymentGatewayAdapter` + its conformance
      spec green; the repository compiles against `IPaymentRepositoryPort`.
- [ ] `PAYMENT_GATEWAY` is bound to `FakePaymentGatewayAdapter` in `orders.module.ts`;
      the retail microservice boots.
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` + `yarn test:e2e` pass.
- [ ] `05-payment-gateway-port-and-fake-adapter.md` is written.
- [ ] The self-containment grep is clean.
- [ ] `carryover-04.md` is written.
