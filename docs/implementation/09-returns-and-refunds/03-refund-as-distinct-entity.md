# Refund as a distinct entity — the `Refund` aggregate, persistence, and accounting

This document introduces the **`Refund`** aggregate — the record of one gateway refund
interaction against a captured payment — and explains why it is modeled as its own
entity, why it lives in the retail `orders/` module rather than the returns context,
and how it accounts for partial-vs-full refunds against a payment. It covers the data +
domain foundation: the model, the persisted `refund` table, the mapper, the repository
port, the wire enum/view, and the migration. The operation that creates a refund (Issue
Refund), the `Payment.refund()` mutator that finally moves the money counters, and the
gateway's `refund()` method are described in the sibling refund-operation documents
listed at the end; the auto-refund-from-cancel consumer in its own document.

## 1. Why `Refund` is a separate entity from `ReturnRequest`

A refund is **not** a field on a return. It is its own aggregate, because a refund must
be able to exist in cases where **no return is involved at all**:

- A **chargeback** — the buyer disputes the charge with their bank; money goes back with
  no RMA behind it.
- A **goodwill credit** — support refunds a frustrated customer without any goods coming
  back.
- A **partial price adjustment** — a discount applied after the fact (a late-honored
  promotion, a damaged-in-transit concession) refunds part of the captured amount while
  the customer keeps the item.
- A **refund issued by Cancel Order** on an order that was paid but never shipped — the
  payment is reversed without a return, because nothing left the warehouse.

If the refund were a field (`refundAmountMinor`, `refundedAt`, …) on `ReturnRequest`,
every one of those cases would be impossible to represent — there would be no row to
hang the refund on. Conversely, a return can **close without any refund**: a `scrap`
disposition on a defective item that earns nothing back closes the RMA with no money
movement.

So the two have **independent lifecycles**, and coupling them in one row would force
each to carry the other's nullable fields and conditional logic. A `Refund` is its own
aggregate, and a return that closes with money owed *triggers* a refund (through the
same Issue Refund path the manual and chargeback flows use) rather than *being* one.

## 2. Why `Refund` lives in `orders/`, not `returns/`

The bounded-context boundary here is decided by **which aggregate a refund's operations
mutate**, not by conceptual proximity to returns.

A refund's operations act on **`Payment`**: they walk its status (`captured →
refunded` on a full refund) and increment its cumulative `refunded_amount_minor`
counter. `Payment` is a sibling aggregate inside `orders/` (it lives there because every
payment operation touches the `Order` aggregate — see
[`docs/adr/028-cart-order-payment-and-address-chain.md`](../../adr/028-cart-order-payment-and-address-chain.md)
§4). Placing `Refund` anywhere else — in the returns context, say — would re-import the
orders context across a module boundary, the precise coupling the per-module isolation
rule forbids and that ADR-028 §4 already avoids for `Payment`.

So `Refund` joins `Payment`, `Address`, and `Fulfillment` as a **sibling aggregate in
the one `orders/` bounded context**, and it reuses that context's single concrete
throwable, `OrderDomainException` (with `OrderErrorCodeEnum`) — the
one-class-per-module convention. The returns context
([`01-rma-lifecycle.md`](./01-rma-lifecycle.md)) never imports the orders module; when a
closing return needs to trigger a refund, that crossing happens at the use-case /
eventing layer, not by importing the `Refund` aggregate into `returns/`. See
[`docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md`](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)
for the full module-split rationale.

## 3. Partial-vs-full refund accounting

The accounting authority is **`payment.refunded_amount_minor`** — a cumulative counter,
shipped (with no writer) by ADR-028 §6 and consumed by the refund capability. Its
contract:

- `refunded_amount_minor` accumulates across every issued refund against a payment. It
  starts at `0` for a freshly authorized payment.
- The **refund ceiling** at any moment is `payment.amount_minor −
  payment.refunded_amount_minor` — what is left to refund. A refund whose amount would
  push the cumulative total past `amount_minor` is rejected
  (`REFUND_EXCEEDS_REFUNDABLE`, 409). This ceiling, plus the gateway-reference natural
  idempotency, is what stops a replay from over-refunding — there is no transactional
  outbox / event-store yet (the ADR-028 §6 posture).
- A refund that brings the cumulative total **exactly to `amount_minor`** is a **full**
  refund: it walks the payment to `status = refunded` and clears its
  `flagged_for_refund` flag (the flag Cancel Order sets on a captured-payment
  cancellation, ADR-031). A refund that leaves a remainder is a **partial** refund: the
  payment **stays `captured`** (the money is still partly held), the flag is untouched,
  and only the counter advances.

This is the entity's *contract*; the writer (the `Payment.refund()` mutator that
performs the increment and the conditional status flip) and the over-refund guard that
reads the counter both land with the Issue Refund operation — they are deliberately
absent from this foundation, the same `version`/`flagged_for_refund`-ship-ahead-of-their-writer
posture ADR-028 §6 established. The `Refund` aggregate itself **cannot see `Payment`**,
so it does not — and must not — enforce the ceiling; it enforces only its own shape (a
positive amount, a non-empty reason, legal status transitions).

## 4. The `Refund` status machine

`Refund.status` (`RefundStatusEnum`, a wire contract on the `refund.status` ENUM column)
walks:

```
pending → issued    (the gateway refund succeeded)
pending → failed    (the gateway declined — terminal)
```

A refund row only ever exists because Issue Refund opened it, so its earliest state is
`pending`: the row is written **before** the gateway is called, recording the intent.
Once the gateway answers, the refund walks to exactly one terminal state:

- **`markIssued({ gatewayReference, issuedAt })`** — `pending → issued`. Stamps the
  opaque `gateway_reference` the processor returned and the `issued_at` moment. This is
  where the refund becomes a real money movement.
- **`markFailed()`** — `pending → failed` (terminal). The gateway declined. This is
  unreachable with the always-succeed in-process fake gateway, but it is modeled so a
  real decline has a home — the same posture as `ORDER_PAYMENT_NOT_APPROVED` for a
  declined authorize.

Both mutators reject an illegal start (a double-issue, issuing a failed refund, failing
an issued one) with `REFUND_INVALID_STATUS_TRANSITION` (409). `issued` and `failed` are
terminal; a refund row is **append-only** — a decline is recorded as `status = failed`,
never a row delete, so `deleted_at` (present because the entity extends `BaseEntity`)
stays inert. `gateway_reference` and `issued_at` are both `null` while `pending` and are
stamped together on issue, so a pending refund surfaces `status = 'pending'` with both
null.

The model records **no domain events** — the `retail.refund.issued` / `retail.refund.failed`
events are built and emitted by the Issue Refund use case after persistence assigns the
id (the `Order.place` /
[`011-notifier-port-and-adapters.md`](../../adr/011-notifier-port-and-adapters.md)
precedent), not pulled from the aggregate.

### Error codes

Seven `OrderErrorCodeEnum` members back the refund capability (all mapped in the orders
module's total `Record<OrderErrorCodeEnum, HttpStatus>` exception filter, so a missing
arm is a compile error). The model throws three of them; the rest are thrown by the
Issue Refund / refund-read operations:

| Code                               | HTTP | Thrown by    | Meaning                                                          |
| ---------------------------------- | ---- | ------------ | ---------------------------------------------------------------- |
| `REFUND_AMOUNT_INVALID`            | 400  | model        | amount not a strictly positive integer (distinct from `PAYMENT_AMOUNT_INVALID`, which allows 0) |
| `REFUND_REASON_REQUIRED`           | 400  | model        | empty reason                                                     |
| `REFUND_INVALID_STATUS_TRANSITION` | 409  | model        | `markIssued` / `markFailed` from a non-`pending` state           |
| `REFUND_NOT_FOUND`                 | 404  | use case     | the refund being read/operated on does not exist                 |
| `REFUND_EXCEEDS_REFUNDABLE`        | 409  | use case     | amount > `amount_minor − refunded_amount_minor` (the over-refund ceiling) |
| `REFUND_PAYMENT_NOT_CAPTURED`      | 409  | use case     | the payment is not `captured`, so there is nothing to refund     |
| `REFUND_ACCESS_FORBIDDEN`          | 403  | use case     | the caller is neither the refunded order's owner nor staff       |

`Refund.amountMinor` is **strictly positive** — a zero/negative refund is meaningless —
so it gets its own `REFUND_AMOUNT_INVALID` code rather than reusing `Payment`'s
`PAYMENT_AMOUNT_INVALID` (which permits 0 for a free-order authorize). The construction
guards that are *not* refund-specific — a positive integer `orderId` / `paymentId`, a
non-empty `currency` — reuse the orders module's existing shared codes
(`PAYMENT_ORDER_ID_INVALID`, `PAYMENT_CURRENCY_REQUIRED`), the one-throwable-per-module
convention. `REFUND_ACCESS_FORBIDDEN` is a **dedicated** code rather than a reuse of
`ORDER_ACCESS_FORBIDDEN`, so the refund-read surface carries its own messaging.

## 5. Schema

The `refund` table (migration `1781859356461-CreateRefundTable`):

| Column              | Type                                   | Notes                                                       |
| ------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `id`                | `BIGINT UNSIGNED AUTO_INCREMENT` PK    | `BaseEntity`'s numeric PK, widened to BIGINT by the migration |
| `order_id`          | `BIGINT UNSIGNED NOT NULL`             | FK → `order(id)` `ON DELETE RESTRICT` (`FK_REFUND_ORDER`)   |
| `payment_id`        | `BIGINT UNSIGNED NOT NULL`             | FK → `payment(id)` `ON DELETE RESTRICT` (`FK_REFUND_PAYMENT`) |
| `amount_minor`      | `BIGINT NOT NULL`                      | minor units; mysql2 returns it as a string — the mapper coerces with `Number(...)` |
| `currency`          | `CHAR(3) NOT NULL`                     |                                                             |
| `status`            | `ENUM('pending','issued','failed')`    | default `'pending'`                                         |
| `reason`            | `VARCHAR(255) NOT NULL`                |                                                             |
| `gateway_reference` | `VARCHAR(255) NULL`                    | null while `pending`; stamped on issue                     |
| `issued_at`         | `TIMESTAMP NULL`                       | null while `pending`; stamped on issue                     |
| `created_at` / `updated_at` / `deleted_at` | `TIMESTAMP`             | `deleted_at` **inert** — a refund is never soft-deleted     |

Both FKs are `ON DELETE RESTRICT`: a refund is an append-only audit record of money
returned, so neither its order nor its payment can be hard-deleted out from under it.
`Refund` is its own aggregate root (not a child of `Order` or `Payment`), so `order_id`
and `payment_id` are plain BIGINT scalars + foreign keys rather than owned-child
relations — the same shape `payment.order_id` uses for its opaque FK. Two indexes —
`IDX_REFUND_ORDER (order_id)` and `IDX_REFUND_PAYMENT (payment_id)` — back the
`findByOrderId` / `findByPaymentId` history reads (the latter feeds the over-refund
guard at issue time). The table is `utf8mb4_unicode_ci` so its implicit collation
matches the rest of the schema. No new `payment` migration is needed: the two
forward-shipped columns the refund flow consumes (`flagged_for_refund`,
`refunded_amount_minor`) already exist.

### Repository seam

`IRefundRepositoryPort` (`REFUND_REPOSITORY`) returns domain types only — no TypeORM
leak (ADR-017). It declares `save` (single-row upsert + re-read so the generated BIGINT
id comes back concrete), `findById`, `findByOrderId` (newest-first by `issued_at` then
`id`), and `findByPaymentId` (the per-payment history backing the over-refund guard).
`save` / `findById` / `findByPaymentId` accept an optional transaction scope so Issue
Refund can persist the `Refund` and advance the `Payment` in one short follow-up
transaction (the `PaymentTypeormRepository` precedent, ADR-017 §6).
`RefundTypeormRepository` is the single `@InjectRepository(RefundEntity)` site.

## 6. Related decisions and forward links

- [`docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md`](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)
  — the whole returns-and-refunds capability, including `Refund`-as-distinct-entity and
  the partial-vs-full accounting.
- [`docs/adr/028-cart-order-payment-and-address-chain.md`](../../adr/028-cart-order-payment-and-address-chain.md)
  — the `orders/` module shape, the sibling-aggregate pattern, and the
  `flagged_for_refund` / `refunded_amount_minor` forward-shipped columns (§6).
- [`01-rma-lifecycle.md`](./01-rma-lifecycle.md) — the `ReturnRequest` aggregate a
  closing return triggers a refund from.
- `04-auto-refund-from-cancel-order.md` (forthcoming) — the consumer that issues a
  refund automatically when Cancel Order flags a captured payment.
- `05-fake-gateway-refund-method.md` (forthcoming) — the `FakePaymentGatewayAdapter`'s
  always-succeed `refund()` that makes the flow exercisable end-to-end, and the
  `Payment.refund()` mutator + over-refund guard that this foundation defers.
