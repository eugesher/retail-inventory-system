---
epic: epic-05
task_number: 4
title: Add `payment` table, domain, persistence; introduce `PAYMENT_GATEWAY` port + `FakePaymentGatewayAdapter`
depends_on: [01, 02, 03]
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/05-payment-gateway-port-and-fake-adapter.md
---

# Task 04 — Add `payment` + introduce `PAYMENT_GATEWAY` port + `FakePaymentGatewayAdapter`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** [ADR-004](../../docs/adr/004-adopt-hexagonal-architecture-per-service.md) (per-module hexagonal — the new `infrastructure/payment-gateway/` folder is a peer to `persistence/` and `messaging/`), [ADR-011](../../docs/adr/011-notifier-port-and-adapters.md) (`INotifierPort` is the analogue — port-and-adapter with a log adapter default; same shape applies to `PAYMENT_GATEWAY`), [ADR-019](../../docs/adr/019-typeorm-and-mysql-for-persistence.md) (persistence conventions), [ADR-017](../../docs/adr/017-architecture-lint-via-eslint-boundaries.md) (the `application/use-case` layer must not import the gateway adapter directly — DI via the port symbol).

## Goal

Land `Payment` as a domain object + persistence layer + the `IPaymentGatewayPort` abstraction. The fake adapter (`FakePaymentGatewayAdapter`) is the default binding; it always returns `authorized` on `authorize(...)` and `captured` on `capture(...)`, with a `gatewayReference` that is a deterministic UUID derived from the order id + a fixed namespace (so the response is testable). The real-gateway adapter is `epic-15` and lives in `docs/extensions/` until then.

The `Payment` model is intentionally simple: a 1:1 association with `Order` (one Payment per Order in this epic; partial captures and split tenders are `epic-09`). The model carries its own status machine (`authorized` → `captured` | `voided`; `authorized` → `failed` if the gateway later returns a non-success on a re-poll, though this path is unreachable today); the Order's `paymentStatus` field (task-03) is a denormalized projection of the Payment's status — the doc explains the deliberate redundancy (the Order's column lets the list-my-orders read path avoid joining Payment).

## Entry state assumed

Task-03 carryover present:

- `order` + `order_line` + `address` tables exist.
- `Order` aggregate has `markPaymentAuthorized` / `markPaymentCaptured` / `markPaymentFailed` mutators.
- `OrderTypeormRepository.save` + `findById` + `findByOrderNumber` are real.
- `modules/orders/` is otherwise as task-03 left it.

This task does NOT add use cases. Task-06's `PlaceOrderUseCase` and task-07's `CapturePaymentUseCase` are the first writers; task-08 reads via `findByOrderId` for the GET Order response.

## Scope

**In:**

- New `apps/retail-microservice/src/modules/orders/domain/payment.model.ts`:
  - `Payment` aggregate (no `pullDomainEvents` — task-06 + task-07 emit `retail.payment.authorized` / `retail.payment.captured` directly via the publisher port, mirroring the inventory-side StockLevel pattern from epic-04 task-04 where the aggregate is not an `AggregateRoot`).
  - Props: `orderId`, `amountMinor`, `currency`, `method` (opaque string returned by the gateway — `'fake-gateway-token-...'`), `status` (enum `'authorized' | 'captured' | 'voided' | 'refunded' | 'failed'`), `gatewayReference` (UUID), `authorizedAt` (Date), `capturedAt` (Date | null).
  - Mutators: `markCaptured(capturedAt: Date)` — only from `authorized`; `markVoided(at: Date)` — only from `authorized`; `markRefunded(at: Date)` — only from `captured` (`epic-09` uses this; epic-05's CapturePaymentUseCase will not reach it).
  - Spec at `modules/orders/domain/spec/payment.model.spec.ts`.
- New `apps/retail-microservice/src/modules/orders/domain/payment-status.enum.ts` for the Payment side. (Task-03 introduced an enum of the same name for the Order's projection; the two enums share values but live in separate files. The doc explains why duplication is intentional: the Order's enum has only the values reachable from Order's transition table — `none | authorized | captured | refunded | failed` — and lacks `voided`; the Payment's enum has the full payment lifecycle including `voided`.) Verify by re-reading task-03's file before deciding whether to consolidate; the doc captures the chosen path.
- New `application/ports/payment.repository.port.ts`:
  - `IPaymentRepositoryPort` with `save(payment: Payment): Promise<Payment>`, `findById(id: number): Promise<Payment | null>`, `findByOrderId(orderId: number): Promise<Payment | null>`, `findByGatewayReference(ref: string): Promise<Payment | null>` (epic-12's Idempotency-Key dedupe will consult this).
  - `PAYMENT_REPOSITORY` DI symbol.
- New `application/ports/payment-gateway.port.ts`:
  - `IPaymentGatewayPort` interface with:
    - `authorize(payload: IPaymentGatewayAuthorizePayload): Promise<IPaymentGatewayAuthorizeResult>`
    - `capture(payload: IPaymentGatewayCapturePayload): Promise<IPaymentGatewayCaptureResult>`
    - (Future) `void(...)`, `refund(...)` — `epic-09` adds them.
  - `PAYMENT_GATEWAY` DI symbol.
  - Payload + result interfaces in `libs/contracts/retail/payment/` (this lib lives across services — the future `epic-15` real-gateway adapter, when colocated with retail, needs the same types).
- New `infrastructure/persistence/payment.entity.ts` + `payment.mapper.ts` + `payment-typeorm.repository.ts`:
  - PK BIGINT auto-increment. `order_id` FK to `order.id ON DELETE RESTRICT` (orders are append-only; their payments are too).
  - `amount_minor` BIGINT NOT NULL. `currency` CHAR(3) NOT NULL. `method` VARCHAR(64) NOT NULL. `status` ENUM. `gateway_reference` VARCHAR(64) NOT NULL with a unique index. `authorized_at` TIMESTAMP NOT NULL. `captured_at` TIMESTAMP NULL.
- New `infrastructure/payment-gateway/fake-payment-gateway.adapter.ts`:
  - Implements `IPaymentGatewayPort`.
  - `authorize(...)` returns `{ status: 'authorized', method: 'fake-gateway-token-' + payload.orderId, gatewayReference: deterministicUuid(...) }`. The deterministic UUID is generated via `crypto.createHash('sha1').update(...)` over the order id + a fixed namespace; the implementer is free to use `uuid v5` if `uuid` is already a dependency (verify before adding).
  - `capture(...)` returns `{ status: 'captured' }`.
  - No persistence — the adapter is stateless. The Payment row is owned by the use case (task-06 inserts `authorized`; task-07 updates to `captured`).
- New `infrastructure/payment-gateway/spec/fake-payment-gateway.adapter.spec.ts` — adapter contract conformance: `authorize(...)` returns a result that satisfies the port type; `capture(...)` returns success; the same `(orderId, amountMinor)` produces the same `gatewayReference` (proves determinism so the e2e test in task-12 can assert on it).
- Update `infrastructure/orders.module.ts`:
  - `DatabaseModule.forFeature([..., PaymentEntity])`.
  - Provider list adds `{ provide: PAYMENT_REPOSITORY, useClass: PaymentTypeormRepository }, PaymentTypeormRepository, { provide: PAYMENT_GATEWAY, useClass: FakePaymentGatewayAdapter }, FakePaymentGatewayAdapter`.
  - `exports: [PAYMENT_REPOSITORY, PAYMENT_GATEWAY]`.
- New `libs/contracts/retail/payment/` subfolder:
  - `payment-status.enum.ts` — wire enum mirror.
  - `payment-method.types.ts` — opaque-token alias `export type PaymentMethodToken = string;`.
  - `gateway/authorize-payload.ts`, `authorize-result.ts`, `capture-payload.ts`, `capture-result.ts` — the four payload/result interfaces.
  - `events/payment-authorized.event.ts`, `events/payment-captured.event.ts` — wire interfaces (extending `ICorrelationPayload` + `occurredAt: string`). Task-06 and task-07 emit against these.
  - `dto/payment-summary.dto.ts` — reserved for task-08's GET Order response (a payment summary attached to the order body).
  - `index.ts` — barrel.
- Update `libs/contracts/retail/index.ts` to re-export from `payment/`.
- New migration `migrations/<timestamp>-CreatePaymentTable.ts`. Up: create `payment` with the columns + the `gateway_reference` unique index. Down: drop the table.
- Doc deliverable `05-payment-gateway-port-and-fake-adapter.md` — entire file written here.

**Out:**

- Wiring the `PAYMENT_GATEWAY` into the use case — tasks 06 + 07.
- Emitting `retail.payment.authorized` / `retail.payment.captured` — task-06 wires the authorize emission; task-07 wires the capture emission.
- Real gateway adapters (Stripe / PayPal / etc.) — `epic-15`.
- Partial captures, split tenders — `epic-09`.
- Refund/void flow — `epic-09`.

## `Payment` shape

```ts
import { PaymentStatusEnum } from './payment-status.enum';

export interface IPaymentProps {
  orderId: number;
  amountMinor: number;
  currency: string;
  method: string;
  status: PaymentStatusEnum;
  gatewayReference: string;
  authorizedAt: Date;
  capturedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class Payment {
  private constructor(public readonly id: number | null, private props: IPaymentProps) {}

  public static authorize(payload: {
    orderId: number;
    amountMinor: number;
    currency: string;
    method: string;
    gatewayReference: string;
  }): Payment {
    if (payload.amountMinor < 0) throw new Error('amountMinor must be ≥ 0');
    if (!/^[A-Z]{3}$/.test(payload.currency)) {
      throw new Error('currency must be ISO 4217');
    }
    if (payload.gatewayReference.trim().length === 0) {
      throw new Error('gatewayReference must be non-empty');
    }
    const now = new Date();
    return new Payment(null, {
      orderId: payload.orderId,
      amountMinor: payload.amountMinor,
      currency: payload.currency,
      method: payload.method,
      status: PaymentStatusEnum.Authorized,
      gatewayReference: payload.gatewayReference,
      authorizedAt: now,
      capturedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  public static rehydrate(id: number, props: IPaymentProps): Payment {
    return new Payment(id, props);
  }

  public markCaptured(capturedAt: Date): void {
    if (this.props.status !== PaymentStatusEnum.Authorized) {
      throw new Error(
        `Cannot capture Payment from ${this.props.status}; expected Authorized`,
      );
    }
    this.props.status = PaymentStatusEnum.Captured;
    this.props.capturedAt = capturedAt;
    this.props.updatedAt = new Date();
  }

  public markVoided(at: Date): void {
    if (this.props.status !== PaymentStatusEnum.Authorized) {
      throw new Error(
        `Cannot void Payment from ${this.props.status}; expected Authorized`,
      );
    }
    this.props.status = PaymentStatusEnum.Voided;
    this.props.updatedAt = at;
  }

  public markRefunded(at: Date): void {
    if (this.props.status !== PaymentStatusEnum.Captured) {
      throw new Error(
        `Cannot refund Payment from ${this.props.status}; expected Captured`,
      );
    }
    this.props.status = PaymentStatusEnum.Refunded;
    this.props.updatedAt = at;
  }

  public markFailed(at: Date): void {
    if (this.props.status !== PaymentStatusEnum.Authorized) {
      throw new Error(
        `Cannot mark failed from ${this.props.status}; expected Authorized`,
      );
    }
    this.props.status = PaymentStatusEnum.Failed;
    this.props.updatedAt = at;
  }

  // ...accessors omitted.
}
```

## `FakePaymentGatewayAdapter` shape

```ts
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createHash } from 'node:crypto';

import {
  IPaymentGatewayAuthorizePayload,
  IPaymentGatewayAuthorizeResult,
  IPaymentGatewayCapturePayload,
  IPaymentGatewayCaptureResult,
} from '@retail-inventory-system/contracts';

import { IPaymentGatewayPort } from '../../application/ports';

const FAKE_GATEWAY_UUID_NAMESPACE = 'ris-fake-payment-gateway::v1';

@Injectable()
export class FakePaymentGatewayAdapter implements IPaymentGatewayPort {
  constructor(
    @InjectPinoLogger(FakePaymentGatewayAdapter.name)
    private readonly logger: PinoLogger,
  ) {}

  public async authorize(
    payload: IPaymentGatewayAuthorizePayload,
  ): Promise<IPaymentGatewayAuthorizeResult> {
    const gatewayReference = this.deterministicReference(payload.orderNumber, 'authorize');
    this.logger.info(
      { correlationId: payload.correlationId, orderNumber: payload.orderNumber, gatewayReference },
      'FakePaymentGateway.authorize',
    );
    return {
      status: 'authorized',
      method: `fake-gateway-token-${payload.orderNumber}`,
      gatewayReference,
    };
  }

  public async capture(
    payload: IPaymentGatewayCapturePayload,
  ): Promise<IPaymentGatewayCaptureResult> {
    this.logger.info(
      { correlationId: payload.correlationId, gatewayReference: payload.gatewayReference },
      'FakePaymentGateway.capture',
    );
    return { status: 'captured' };
  }

  private deterministicReference(orderNumber: string, op: 'authorize' | 'capture'): string {
    // Deterministic so e2e tests can assert on the value. SHA-1 truncated to
    // 36 chars (with hyphens at the UUID-shaped offsets) so the column type
    // CHAR(36) on the unique gateway_reference index is satisfied.
    const hex = createHash('sha1')
      .update(`${FAKE_GATEWAY_UUID_NAMESPACE}::${orderNumber}::${op}`)
      .digest('hex');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join('-');
  }
}
```

Notes:

- The fake adapter NEVER fails. The walking-skeleton e2e tests need a predictable success path. A future `FakeFailingPaymentGatewayAdapter` (one that returns `failed` from `authorize`) is a small follow-up; doc 05 names the addition explicitly so a future contributor knows where to put it.
- `gatewayReference` is deterministic by `(orderNumber, op)`. The same Place Order call produces the same `authorize` ref; the same Capture call produces the same `capture` ref. The unique index on the column does not fire in normal flow because we only insert one row per order/payment lifecycle.
- The adapter logs at `info` for both ops, with `correlationId` inline (ADR-011 §7 — `@EventPattern`/`@MessagePattern` scope; the use case calling the adapter is itself in a `@MessagePattern` scope at the controller boundary). Never use `@nestjs/common`'s `Logger`; always inject `PinoLogger`.

## Files to add

- `apps/retail-microservice/src/modules/orders/domain/payment.model.ts`
- `apps/retail-microservice/src/modules/orders/domain/payment-status.enum.ts` (the Payment-side enum — task-03's order-side payment-status enum lives at `domain/order-payment-status.enum.ts` or `domain/payment-status.enum.ts` depending on the decision in §"Scope" above; the implementer picks one path and documents in doc 05)
- `apps/retail-microservice/src/modules/orders/domain/spec/payment.model.spec.ts`
- `apps/retail-microservice/src/modules/orders/application/ports/payment.repository.port.ts`
- `apps/retail-microservice/src/modules/orders/application/ports/payment-gateway.port.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/payment.entity.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/payment.mapper.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/payment-typeorm.repository.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/payment-gateway/fake-payment-gateway.adapter.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/payment-gateway/spec/fake-payment-gateway.adapter.spec.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/payment-gateway/index.ts`
- `migrations/<timestamp>-CreatePaymentTable.ts`
- `libs/contracts/retail/payment/payment-status.enum.ts`
- `libs/contracts/retail/payment/payment-method.types.ts`
- `libs/contracts/retail/payment/gateway/authorize-payload.ts`
- `libs/contracts/retail/payment/gateway/authorize-result.ts`
- `libs/contracts/retail/payment/gateway/capture-payload.ts`
- `libs/contracts/retail/payment/gateway/capture-result.ts`
- `libs/contracts/retail/payment/gateway/index.ts`
- `libs/contracts/retail/payment/events/payment-authorized.event.ts`
- `libs/contracts/retail/payment/events/payment-captured.event.ts`
- `libs/contracts/retail/payment/events/index.ts`
- `libs/contracts/retail/payment/dto/payment-summary.dto.ts`
- `libs/contracts/retail/payment/index.ts`
- `docs/implementation/05-cart-order-payment-walking-skeleton/05-payment-gateway-port-and-fake-adapter.md`

## Files to modify

- `apps/retail-microservice/src/modules/orders/application/ports/index.ts` — re-export `IPaymentRepositoryPort`, `PAYMENT_REPOSITORY`, `IPaymentGatewayPort`, `PAYMENT_GATEWAY`.
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/index.ts` — re-export `PaymentEntity`, `PaymentTypeormRepository`, the mapper.
- `apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts` — `forFeature` extended with `PaymentEntity`; provider list extended with the repository + gateway adapter; exports extended.
- `apps/retail-microservice/src/modules/orders/domain/index.ts` — re-export `Payment`, `PaymentStatusEnum`.
- `libs/contracts/retail/index.ts` — re-export from `payment/`.

## Tests

- `payment.model.spec.ts` — ≥7 cases: `authorize` succeeds for a positive amount; `authorize` rejects a negative amount; ISO-currency required; non-empty gatewayReference required; `markCaptured` from authorized succeeds and stamps `capturedAt`; `markCaptured` from non-authorized rejects; `markVoided` from authorized succeeds; `markRefunded` from non-captured rejects; `markFailed` from authorized succeeds.
- `fake-payment-gateway.adapter.spec.ts` — ≥4 cases: `authorize` returns `status='authorized'`; the gateway reference is deterministic by (orderNumber, op); two distinct orderNumbers produce distinct references; `capture` returns `status='captured'`.
- `yarn lint` passes.
- `yarn build:retail-microservice` succeeds.
- `yarn migration:run` creates the `payment` table with the `gateway_reference` unique index.

## Doc deliverable

Write `docs/implementation/05-cart-order-payment-walking-skeleton/05-payment-gateway-port-and-fake-adapter.md` (target ~120 lines). Sections:

1. **Why a port-and-adapter for payments.** Restate the ADR-011 analogue: the `INotifierPort` shape that lets the notification microservice swap a log adapter for an email adapter without touching the use cases is the template. Payments are the same shape — the fake adapter lets the walking skeleton run end-to-end today; swapping in a real-gateway adapter behind the port is a Module-level binding change (one line in `orders.module.ts`).
2. **The fake adapter's contract.** `authorize(...)` always returns `'authorized'`. `capture(...)` always returns `'captured'`. The `gatewayReference` is deterministic by `(orderNumber, op)` — important so e2e tests can assert on the value. A `FakeFailingPaymentGatewayAdapter` (always-fail variant) is not shipped today but is a small follow-up; name the file path it would land at: `apps/retail-microservice/.../infrastructure/payment-gateway/fake-failing-payment-gateway.adapter.ts`.
3. **The Payment.status enum vs Order.paymentStatus.** Why the two enums duplicate values. Order has `none | authorized | captured | refunded | failed`; Payment has `authorized | captured | voided | refunded | failed`. The Order's `none` is a non-state that can never be reached by Payment (there is no `Payment` row in the `none` state — the Order is `none` before any Payment row exists). The Payment's `voided` does not propagate to the Order (the Order's `paymentStatus` stays `authorized` if the Payment was voided pre-capture — the doc explains the path: a voided pre-capture means no money moved, and the Order is then `cancelled` not `paymentStatus=voided`; the workflow status carries the cancel signal). This intentional asymmetry is documented now so a future implementer does not "fix" the enum mismatch.
4. **The 1:1 Order ↔ Payment association.** This epic ships one Payment per Order. Partial captures and split tenders are `epic-09`; the repository's `findByOrderId(orderId)` returns the single row today and will become a `findAllByOrderId` in `epic-09`. The mapper hides the cardinality transition.
5. **Deterministic gateway reference.** SHA-1 truncated to UUID-shaped 36 chars over `(namespace, orderNumber, op)`. Why determinism: the e2e test in task-12 asserts on the reference to prove the same Place Order call routes through the gateway exactly once. The unique index on `gateway_reference` ensures the row insert fails if a duplicate is attempted (which is what `epic-12`'s Idempotency-Key dedupe will rely on).
6. **The future real-gateway adapter sketch.** Brief: a real adapter would do HTTP calls to Stripe / PayPal / Adyen / etc. The port's payload + result types are deliberately gateway-agnostic so the adapter can map between the project's `IPaymentGatewayAuthorizePayload` and the gateway's API. Real gateway design notes live under `docs/extensions/` post-`epic-15`. Link forward to `epic-15` for the exclusions list (BNPL, B2B PO, etc.).
7. **The PCI compliance and tokenization out-of-scope notice.** The fake never sees a real card number. The future real adapter will use the gateway's tokenization endpoint — the project never touches a PAN. Compliance scope: `epic-15`.
8. **Boundaries.** `PAYMENT_GATEWAY` adapter lives in `infrastructure/payment-gateway/`. The use cases (task-06, task-07) inject `PAYMENT_GATEWAY` (the symbol), never `FakePaymentGatewayAdapter` (the class). Per ADR-017 the architecture lint asserts the use-case layer cannot import from `infrastructure/payment-gateway/*`. Task-12 extends the lint fixtures to cover this new element type.

## Carryover produced (consumed by task-05 onward — though the cart side does not touch PAYMENT_GATEWAY; task-06 is the first consumer)

- New `payment` table in MySQL.
- `Payment` aggregate + Payment-side status enum on disk.
- `IPaymentRepositoryPort` + `PAYMENT_REPOSITORY` symbol available.
- `IPaymentGatewayPort` + `PAYMENT_GATEWAY` symbol available; bound to `FakePaymentGatewayAdapter`.
- The four gateway payload/result interfaces in `libs/contracts/retail/payment/`.
- `orders.module.ts` provides + exports all of the above.
- Doc `05-payment-gateway-port-and-fake-adapter.md` written.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `payment.model.spec.ts` (≥7) and `fake-payment-gateway.adapter.spec.ts` (≥4) green.
- [ ] `yarn build:retail-microservice` succeeds.
- [ ] `yarn migration:run` creates the `payment` table with the `gateway_reference` unique index.
- [ ] `git ls-files apps/retail-microservice/src/modules/orders/infrastructure/payment-gateway/` shows the adapter + the spec + the index.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `05-payment-gateway-port-and-fake-adapter.md` exists with the eight sections above filled.
