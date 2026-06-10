# Carryover 04 — Payment aggregate + PAYMENT_GATEWAY port + FakePaymentGatewayAdapter landed

## Entry state for task-05

The retail `orders/` module now carries the **payment seam** on top of the order/
address foundation: the `Payment` aggregate (domain + persistence + repository), the
`PAYMENT_GATEWAY` port with its default `FakePaymentGatewayAdapter`, and the
`payment` table. It is **foundation only** — **no use cases, publisher, controller,
or gateway HTTP**. The retail microservice still boots on `retail_queue` with **no
`@MessagePattern` / `@EventPattern` handlers** (verified: "Retail Microservice is
listening for messages", clean DI graph).

### Payment domain (`apps/retail-microservice/src/modules/orders/domain/payment.model.ts`)

- **`Payment extends AggregateRoot<number | null>`** — id is the DB-assigned BIGINT
  (null until persisted), like `Order`. It is its **own aggregate root**, NOT a child
  of `Order` (independent lifecycle: authorized-on-place, captured-explicitly), but
  lives **inside the `orders/` module** (ADR-028 §4 — its operations touch `Order`).
  - `Payment.authorized({ orderId, amountMinor, currency, method, gatewayReference,
    authorizedAt })` → the construction path from a successful gateway authorize:
    `status = AUTHORIZED`, `capturedAt = null`.
  - `Payment.reconstitute(props)` → load path (any status).
  - `capture(at: Date)` → the **only** mutation: `AUTHORIZED → CAPTURED`, stamps
    `capturedAt`. Rejects a non-`authorized` start (`PAYMENT_INVALID_STATUS_TRANSITION`).
    **No void/refund/fail** (deliberately — later capabilities).
  - **Records NO domain events** (the `retail.order.placed` / payment wire surface is
    the order use cases' job — task-06/07).
  - Invariants: `orderId` positive int; `amountMinor` non-negative int (0 allowed);
    `currency` / `method` / `gatewayReference` non-empty.
  - Getters: `orderId`, `amountMinor`, `currency`, `method`, `status`,
    `gatewayReference`, `authorizedAt` (`Date|null`), `capturedAt` (`Date|null`),
    `createdAt`, `updatedAt`. `IPaymentProps` / `IPaymentAuthorizedInput` exported.

- **`Payment` reuses `OrderDomainException` + `OrderErrorCodeEnum`** (NOT a separate
  throwable — the one-per-module convention; carryover-03 instructed this). **Six new
  codes added** to `OrderErrorCodeEnum`: `PAYMENT_ORDER_ID_INVALID`,
  `PAYMENT_AMOUNT_INVALID`, `PAYMENT_CURRENCY_REQUIRED`, `PAYMENT_METHOD_REQUIRED`,
  `PAYMENT_GATEWAY_REFERENCE_REQUIRED` (all 400), `PAYMENT_INVALID_STATUS_TRANSITION`
  (409). The HTTP filter that maps these arrives with the operations (task-05/06/07).

### `PAYMENT_GATEWAY` port + fake adapter

- **`IPaymentGatewayPort` (`PAYMENT_GATEWAY` symbol;
  `application/ports/payment-gateway.port.ts`)** — domain/contract types only, **no
  transport/HTTP import** (ADR-004/017). Shape:
  - `authorize(req: IPaymentAuthorizeRequest): Promise<IPaymentAuthorizeResult>`
  - `capture(gatewayReference: string, correlationId?: string): Promise<IPaymentCaptureResult>`
  - `IPaymentAuthorizeRequest { orderId, amountMinor, currency, method?, correlationId? }`
  - `IPaymentAuthorizeResult { approved, gatewayReference, method, authorizedAt }`
  - `IPaymentCaptureResult { captured, gatewayReference, capturedAt }`
- **`FakePaymentGatewayAdapter`
  (`infrastructure/payment-gateway/fake-payment-gateway.adapter.ts`)** — the **bound
  default** (`@Injectable`). **Always approves**: `authorize` → `{ approved: true,
  gatewayReference: 'fake_' + randomUUID(), method: req.method ?? 'fake-card',
  authorizedAt: new Date() }`; `capture` → `{ captured: true, gatewayReference,
  capturedAt: new Date() }`. No external calls/persistence. Each authorize mints a
  **distinct** `gatewayReference` (the unique column relies on it).
  - **DEVIATION (respect):** the adapter's `capture` implements **only the first
    param** (`gatewayReference`) — the optional `correlationId` is dropped because
    the lint rejects an unused param and the fake doesn't log/trace. A real adapter
    implements the full arity (TS allows narrowing an optional trailing param).
  - The `NotifierPort` default-adapter pattern (ADR-011). Swapping a real gateway =
    one provider rebinding + an HTTP-doing sibling adapter, no use-case change.

### Repository port (`application/ports/payment.repository.port.ts`)

`PAYMENT_REPOSITORY` symbol; `IPaymentRepositoryPort`:

```ts
save(payment: Payment): Promise<Payment>;        // re-reads for the concrete id
findById(id: number): Promise<Payment | null>;
findByOrderId(orderId: number): Promise<Payment | null>;  // one payment per order here
```

`PaymentTypeormRepository` (`infrastructure/persistence/payment-typeorm.repository.ts`)
— single-row upsert + re-read by id (the "re-read the saved graph" idiom);
`findByOrderId` orders `id DESC` defensively. The only new `@InjectRepository` site.

### Persistence + schema (migration `1781187655857-CreatePaymentTable`)

- `payment`: `id BIGINT UNSIGNED` PK, `order_id BIGINT UNSIGNED` NOT NULL,
  `amount_minor BIGINT`, `currency CHAR(3)`, `method VARCHAR(64)`,
  `status ENUM('authorized','captured','voided','refunded','failed')`,
  `gateway_reference VARCHAR(255)`, `authorized_at`/`captured_at TIMESTAMP NULL`,
  timestamps + **inert `deleted_at`**. **`UC_PAYMENT_GATEWAY_REFERENCE` UNIQUE
  (gateway_reference)**; **`FK_PAYMENT_ORDER → order(id) ON DELETE RESTRICT**;
  `IDX_PAYMENT_ORDER (order_id)`. `utf8mb4_unicode_ci`. `down` drops `payment`.
  **Timestamp `1781187655857` is AFTER the order/address migration
  `1781101255857`** (migrations run in timestamp order; `Date.now()` today is
  ~`1781048…`, *behind* the fabricated future-dated chain — pick the next slot
  manually, do NOT trust `migration:create`'s `Date.now()`).
- **`PaymentEntity` keeps `BaseEntity`'s numeric PK** (migration widens to BIGINT
  UNSIGNED). `order_id` is a **plain `@Column({ type: 'bigint', unsigned: true })`
  scalar with NO `@ManyToOne`** — Payment is its own root, the FK lives only in the
  migration (same opaque-scalar shape `order_line.variant_id` uses, though `order_id`
  is in-module). No `@VersionColumn` (Payment is not OCC-guarded). Mapper coerces
  `id`/`order_id`/`amount_minor` BIGINT strings with `Number(...)`.

### Contracts (`libs/contracts/retail`)

- **`PaymentStatusEnum`** (`enums/payment-status.enum.ts`) = `AUTHORIZED='authorized'`
  / `CAPTURED='captured'` / `VOIDED='voided'` / `REFUNDED='refunded'` /
  `FAILED='failed'`. **Distinct from `OrderPaymentStatusEnum`** (the payment **row**
  status never has `none`; the order **axis** does). Both barrels updated.
- **`PaymentView`** (`dto/payment.view.ts`) — class with `@ApiResponseProperty`:
  `id`, `orderId`, `amountMinor`, `currency`, `method`, `status`, `gatewayReference`,
  `authorizedAt: string|null`, `capturedAt: string|null`. Barrel updated.
- **`OrderView` now has `payment?: PaymentView`** (`@ApiResponseProperty({ type:
  PaymentView })`, optional) — the field task-03 left for this task. The
  view-assembly that populates it lands with the read/capture capability (task-07).

### Module wiring (`infrastructure/orders.module.ts`)

`DatabaseModule.forFeature([OrderEntity, OrderLineEntity, AddressEntity,
PaymentEntity])`; providers add `PaymentTypeormRepository` + `{ provide:
PAYMENT_REPOSITORY, useExisting: PaymentTypeormRepository }` + `{ provide:
PAYMENT_GATEWAY, useClass: FakePaymentGatewayAdapter }`; exports now include
`PAYMENT_REPOSITORY` + `PAYMENT_GATEWAY`. **`PaymentEntity` was added to the
exported `orderEntities` array** (`persistence/index.ts`), which retail
`app.module.ts` spreads into `forRoot([...cartEntities, ...orderEntities])` — so the
root connection registers `payment` **without an `app.module.ts` edit** (the task
listed `app.module.ts` as a file to modify, but spreading `orderEntities` is the
cleaner single-source approach; carryover-03 made `orderEntities` spreadable for
exactly this).

## Files added / modified

**Added** (under `apps/retail-microservice/src/modules/orders/` unless noted):
- `domain/payment.model.ts`, `domain/spec/payment.model.spec.ts`
- `application/ports/payment-gateway.port.ts`, `payment.repository.port.ts`
- `infrastructure/payment-gateway/fake-payment-gateway.adapter.ts`, `index.ts`,
  `spec/fake-payment-gateway.adapter.spec.ts`
- `infrastructure/persistence/payment.entity.ts`, `payment.mapper.ts`,
  `payment-typeorm.repository.ts`, `spec/payment-typeorm.repository.spec.ts`
- `libs/contracts/retail/enums/payment-status.enum.ts`
- `libs/contracts/retail/dto/payment.view.ts`
- `migrations/1781187655857-CreatePaymentTable.ts`
- `docs/implementation/05-cart-order-payment-walking-skeleton/05-payment-gateway-port-and-fake-adapter.md`

**Modified**:
- `domain/order.exception.ts` — six `PAYMENT_*` codes + header comment.
- `domain/index.ts` — export `payment.model`.
- `application/ports/index.ts` — export the two new ports.
- `infrastructure/persistence/index.ts` — `PaymentEntity` into `orderEntities` +
  re-exports.
- `infrastructure/orders.module.ts` — the entity, repository+port, and gateway
  bindings.
- `libs/contracts/retail/{enums/index,dto/index}.ts` — export the new contracts.
- `libs/contracts/retail/dto/order.view.ts` — `payment?: PaymentView`.
- `README.md` (DB diagram box, services table retail row, retail section + app tree)
  + `CLAUDE.md` (app tree retail line, retail message-pattern note, `modules/orders/`
  section, contracts retail sub-area, DB entity locations). **CLAUDE.md is
  git-excluded** (`.git/info/exclude`) — edits are on disk but won't show in `git
  status`.

No ADR introduced — ADR-028 governs.

## Known gaps / deferrals (each names its owning task)

- **Authorize-on-place** (Place Order calls `PAYMENT_GATEWAY.authorize`, builds a
  `Payment.authorized(...)`, persists via `PAYMENT_REPOSITORY`, calls
  `order.markPaymentAuthorized()`, emits `retail.order.placed`) → **task-06**.
- **Capture** (`PAYMENT_GATEWAY.capture`, `payment.capture(at)`,
  `order.markPaymentCaptured()`, `order:capture` permission) + **Get/List** that
  populate `OrderView.payment?` via a payment-view factory → **task-07**.
- Cart **operations** + gateway + guest promotion → **task-05**.
- Notification re-point (`retail.order.placed` consumer + e2e) → **task-08**.
- README/CLAUDE full retail rewrite + lint fixtures + `http/*.http` → **task-09**.
- **No use cases / publisher / controller / gateway HTTP / `.http` file** exist for
  payment yet — Authorize/Capture are NOT wired. No new e2e (the payment surface has
  no endpoint to exercise).

## How to verify (all green as of this task)

- `yarn build` — all five apps compile.
- `yarn lint` — clean (`--max-warnings 0`). (Two gotchas hit + fixed: a spec helper
  needs an explicit return type; the fake adapter must not declare the unused
  `correlationId` param.)
- `yarn test:unit` — **605 pass** (was 583; +22 from the payment domain / adapter /
  repository specs).
- **Migration round-trip** (infra up): `yarn migration:run` creates `payment`
  (verified `SHOW CREATE TABLE payment` — BIGINT UNSIGNED PK, `UC_PAYMENT_GATEWAY_REFERENCE`
  UNIQUE, `FK_PAYMENT_ORDER → order(id) ON DELETE RESTRICT`, `IDX_PAYMENT_ORDER`, the
  five-value ENUM); `yarn migration:revert` drops it (`SHOW TABLES LIKE 'payment'`
  empty); `yarn migration:run` re-creates — **verified clean**.
- `yarn test:e2e` — full infra reload (`down -v` → up → migrate incl.
  CreatePaymentTable from scratch → seed) + **88 e2e pass** (10 suites). No payment
  e2e yet.
- **Boot**: `timeout 25 node dist/apps/retail-microservice/main.js` logs "Retail
  Microservice is listening for messages" with the `cart` + `orders` modules
  registered (no handlers); the `PAYMENT_GATEWAY → FakePaymentGatewayAdapter` +
  three repository bindings resolve (no DI error).
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
