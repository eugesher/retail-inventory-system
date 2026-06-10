# Payment aggregate, the gateway port, and the fake adapter

This change adds the **payment seam** to the retail checkout context: the `Payment`
aggregate (domain + persistence + repository), the `PAYMENT_GATEWAY` port that
abstracts a payment processor, and the default `FakePaymentGatewayAdapter` bound
behind it. It is **foundation only** — there are no use cases and no gateway HTTP
routes yet. Authorizing a payment as part of placing an order, and capturing it
later, both land in later capabilities; this change lands the seam, the persistence,
and the adapter's contract-conformance coverage so those capabilities can wire to a
stable interface.

The decision this implements is recorded in
[ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) §4; the
port-and-adapter shape follows the `NotifierPort` precedent in
[ADR-011](../../adr/011-notifier-port-and-adapters.md). It builds directly on the
immutable order record in
[03-order-three-status-and-q4-decision.md](03-order-three-status-and-q4-decision.md)
(the `payment.order_id` FK points at the `order` table).

## Why a port and a fake adapter, not a real gateway

Integrating a real payment processor (Stripe, PayPal, Adyen, …) is an **excluded
capability** for this system — it requires merchant accounts, webhook endpoints,
PCI-scoped secret handling, and a sandbox/live split that the walking skeleton
deliberately does not take on. But the *shape* of the checkout flow —
authorize-when-an-order-is-placed, capture-when-the-goods-ship — is exactly what we
want to model now.

The resolution is a **port-and-adapter split**. The `IPaymentGatewayPort` interface
declares the two operations the checkout needs:

```ts
authorize(req: IPaymentAuthorizeRequest): Promise<IPaymentAuthorizeResult>;
capture(gatewayReference: string, correlationId?: string): Promise<IPaymentCaptureResult>;
```

The future Place Order and Capture use cases depend **only** on this interface. The
concrete processor is selected by a single provider binding in `orders.module.ts`.
Today that binding is the `FakePaymentGatewayAdapter`; swapping in a real processor
later is:

1. add a sibling adapter under `infrastructure/payment-gateway/` that does the HTTP
   (its `axios`/SDK client is confined to `infrastructure/`, per
   [ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md) /
   [ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md));
2. rebind `PAYMENT_GATEWAY` to it in `orders.module.ts`.

**No use case changes.** This is the same default-adapter-behind-a-port pattern the
notification service uses for `NotifierPort` (a `LogNotifierAdapter` default with
email/webhook adapters as scaffolds) — ADR-011.

### What the fake returns

`FakePaymentGatewayAdapter` is a deterministic, side-effect-free, in-process
stand-in. It **always approves**:

- `authorize(req)` → `{ approved: true, gatewayReference: 'fake_' + randomUUID(),
  method: req.method ?? 'fake-card', authorizedAt: new Date() }`
- `capture(gatewayReference)` → `{ captured: true, gatewayReference, capturedAt:
  new Date() }`

There are **no external calls, no persistence, and no failure paths** — the fake is a
pure function of its inputs (plus a fresh UUID and clock read). Each `authorize`
mints a **distinct** `gatewayReference`; the unique `payment.gateway_reference`
column relies on that. The adapter's unit spec is written as a **contract-conformance
suite** — it pins the result shape (`approved`/`captured` booleans, a non-empty
`gatewayReference` starting `fake_`, an echoed-or-defaulted `method`, `Date`
timestamps, distinct references across calls) so a real adapter can later be held to
the same bar.

## The `Payment` aggregate

A `Payment` is the record of a single gateway interaction for an order. It is its
**own aggregate root** (`extends AggregateRoot<number | null>`), not a child of
`Order`: it has an independent lifecycle (created at authorize, captured later),
while the `Order` header tracks the same progress on its orthogonal **payment axis**
(`OrderPaymentStatusEnum` — see the order doc's Q4 discussion). The two are kept in
step by the use cases that mutate both, not by an ownership relation.

It lives **inside the `orders/` module** rather than in a standalone `payment/`
module (ADR-028 §4): every payment operation touches the `Order` aggregate
(authorize-on-place reads the order total and advances the order's payment axis;
capture advances it again), so payment is part of the order/checkout bounded context,
not a context of its own.

### Fields and invariants

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `number \| null` | DB-assigned BIGINT, null until persisted |
| `orderId` | `number` | the order this pays — positive integer |
| `amountMinor` | `number` | minor units (integer cents), non-negative |
| `currency` | `string` | non-empty |
| `method` | `string` | opaque gateway token (e.g. `fake-card`), non-empty |
| `status` | `PaymentStatusEnum` | the payment-row lifecycle |
| `gatewayReference` | `string` | opaque gateway reference, non-empty, UNIQUE in the DB |
| `authorizedAt` | `Date \| null` | stamped at authorize |
| `capturedAt` | `Date \| null` | null until capture |

Invariant violations throw the orders context's `OrderDomainException` with a typed
`OrderErrorCodeEnum` code (`PAYMENT_*`) — `Payment` **reuses the existing orders
exception** rather than introducing a separate throwable, because it lives in the
same bounded-context module (the one-throwable-per-module convention the cart /
catalog / pricing contexts follow). A presentation-layer filter maps the code to an
HTTP status when the operations land; the domain stays transport-free.

### `PaymentStatusEnum` is a distinct axis from the order's payment status

The payment **row** status is a separate enum from the order's payment **axis**:

| Enum | Members | Lives on |
| --- | --- | --- |
| `OrderPaymentStatusEnum` | `none` · `authorized` · `captured` · `refunded` · `failed` | the `order` header |
| `PaymentStatusEnum` | `authorized` · `captured` · `voided` · `refunded` · `failed` | a `payment` row |

The order axis carries a `none` member for the **pre-payment window** — an order
exists before any money moves. A `payment` **row**, by contrast, only ever exists
because an authorize succeeded, so its earliest state is `authorized`; there is no
`none`. Encoding the distinction as two enums makes the type system, not a comment,
the guard against assigning `none` to a payment row. `voided` is the payment-row
counterpart of an order-level cancel-before-capture.

### One mutation: `capture`

`Payment` exposes exactly **one** state mutation:

- `capture(at: Date)` — `authorized → captured`, stamping `capturedAt`. It rejects
  any non-`authorized` start (a double-capture, or capturing a voided/failed
  payment) with `PAYMENT_INVALID_STATUS_TRANSITION`.

Construction is through `Payment.authorized({ orderId, amountMinor, currency, method,
gatewayReference, authorizedAt })` — the path from a successful gateway authorize,
which opens the payment `AUTHORIZED` with `capturedAt = null` — or `Payment.reconstitute(props)`
on the load path. `void` / `refund` / `fail` transitions are **deliberately absent**:
they would be dead, untested code in this chain. They land with the cancel / refund /
decline capabilities that drive them. The unit spec covers the `authorized` factory
(status + null `capturedAt`), the `authorized → captured` transition, capture's
rejection of a non-authorized payment, and the field invariants.

The aggregate records **no domain events**. The wire events for the checkout flow
(`retail.order.placed`, and the payment surface) belong to the order use cases that
land later, never to the payment domain — domain events are never serialized across
services ([ADR-011](../../adr/011-notifier-port-and-adapters.md) /
[ADR-013](../../adr/013-order-aggregate-and-cross-service-confirm.md)).

## Persistence — the `payment` table

One migration creates the `payment` table (`synchronize` stays off,
[ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `BIGINT UNSIGNED` PK | generated; the entity keeps `BaseEntity`'s numeric PK |
| `order_id` | `BIGINT UNSIGNED` | plain scalar + FK — Payment is its own root, **not** an owned child of Order |
| `amount_minor` | `BIGINT` | minor units; mysql2 returns it as a string, the mapper coerces with `Number(...)` |
| `currency` | `CHAR(3)` | |
| `method` | `VARCHAR(64)` | opaque |
| `status` | `ENUM(...)` | the five `PaymentStatusEnum` values |
| `gateway_reference` | `VARCHAR(255)` | **UNIQUE** (`UC_PAYMENT_GATEWAY_REFERENCE`) |
| `authorized_at` / `captured_at` | `TIMESTAMP NULL` | |
| `created_at` / `updated_at` / `deleted_at` | `TIMESTAMP` | `deleted_at` inert — payments are append-only |

- **`order_id` is a plain column + the `FK_PAYMENT_ORDER` foreign key**, not an
  owned-child `@ManyToOne` relation, because `Payment` is its own aggregate root. The
  FK is `ON DELETE RESTRICT` — an order with a payment can never be deleted out from
  under it. There is also an `IDX_PAYMENT_ORDER` index for the `findByOrderId` lookup.
- **`gateway_reference` is UNIQUE.** Each authorize mints a distinct reference, so
  the column doubles as an idempotency guard against a duplicated gateway callback.
- `PaymentEntity` extends `BaseEntity`, so `deleted_at` exists (TypeORM appends
  `deleted_at IS NULL` to every `find`) — it stays **inert**; a payment is never
  soft-deleted.

`PaymentTypeormRepository` is the single `@InjectRepository` site for the payment
aggregate. Its `save` is a single-row upsert (no owned children, no `@VersionColumn`)
that **re-reads the row by id** so the returned aggregate carries the concrete
generated id and the committed timestamps — the "re-read the saved graph" idiom the
order and address repositories follow. It returns domain types only — no TypeORM type
leaks past it (ADR-017). The port is:

```ts
save(payment: Payment): Promise<Payment>;
findById(id: number): Promise<Payment | null>;
findByOrderId(orderId: number): Promise<Payment | null>;   // one payment per order here
```

`findByOrderId` returns a single `Payment | null` rather than an array because this
capability models **one payment per order**; split-payment and multi-capture are
later capabilities.

## Wire contract

`PaymentView` (a class carrying `@ApiResponseProperty`, the documented lib-contracts
Swagger exception — [ADR-005](../../adr/005-split-shared-common-into-bounded-libs.md))
joins the retail contracts in `libs/contracts/retail`, alongside the
`PaymentStatusEnum`. It carries `id`, `orderId`, `amountMinor`, `currency`, `method`,
`status`, `gatewayReference`, `authorizedAt`, and `capturedAt`. `OrderView` gains an
optional `payment?: PaymentView` field — absent until an order has been
placed-and-authorized, present once a `payment` row exists. The view-assembly that
populates it lands with the order read/capture capabilities.

## Module wiring

`orders.module.ts` registers `PaymentEntity` in its `DatabaseModule.forFeature([...])`
(and `PaymentEntity` joins the exported `orderEntities` array, which the retail
`app.module.ts` spreads into the root connection), provides `PaymentTypeormRepository`
behind the `PAYMENT_REPOSITORY` port symbol (`useExisting`), and binds
`PAYMENT_GATEWAY → FakePaymentGatewayAdapter` via `useClass`. The retail microservice
boots with all of this registered but still serves **no message handlers** — the
payment operations and their gateway routes arrive with the place and capture
capabilities.
