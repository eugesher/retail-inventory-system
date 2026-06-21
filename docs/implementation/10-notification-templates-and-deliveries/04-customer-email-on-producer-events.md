# Carrying the customer email on producer events

The notification service turns a retail business event into an outgoing email. To do that it
needs a **recipient address**. This document explains how the retail microservice resolves
the buyer's email *at the moment it produces an event* and stamps it onto the wire payload,
so the notification consumer never has to reach back across the service boundary for it.

It builds on the [render-and-dispatch pipeline](03-render-and-dispatch-pipeline.md), whose
input carries a `recipientAddress` the consumer must fill; this is the producer half that
makes that address available. It honors
[ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md) (which
records this "carry the email on the event" choice), [ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)
(the raw-SQL cross-module reader, no foreign entity import), and
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md) (publish only inside the
infrastructure publisher; post-commit emits are best-effort).

## 1. The problem: the consumer needs a recipient

A retail event like `retail.order.placed` identifies an order — `orderId`, `orderNumber`,
the money, a `customerId`. It does **not** carry an email address; the customer's contact
details live on the gateway-owned `customer` table, which the notification service has never
read. When the notification consumer (a later capability) receives the event and wants to
send a confirmation, it has to answer one question first: *where do I send it?*

Some events do not even carry the buyer's id. `retail.refund.issued` identifies a refund and
its payment; until now the refund-confirmation recipient was derived as the synthetic string
`order:<orderId>` — a placeholder that no mail transport can actually deliver to.

## 2. The choice: email-on-payload (b) vs. a per-delivery RPC (c)

Two designs can give the consumer a recipient:

- **(c) A per-delivery RPC into the gateway customer module.** When the consumer handles an
  event, it calls the gateway (or a customer-lookup service) to resolve the email. This is
  always-fresh, but it adds a synchronous cross-service round-trip to *every single
  delivery* — and the notification service would gain a hard runtime dependency on the
  gateway being up at consume time, exactly when a retry sweep might be replaying a backlog.

- **(b) Carry the email on the event payload.** The *producer* — the retail service, which
  already owns the order and sits next to the shared database — resolves the email once,
  when it builds the event, and stamps it on the wire. The consumer reads
  `event.customerEmail` with zero extra I/O.

We chose **(b)**. The retail service is the natural place to resolve the contact: it is
already producing the event, it is already inside a transaction boundary that has the
`customerId` in hand, and the read is one indexed primary-key lookup against a table in the
*same* MySQL instance. The cost of (b) is a small staleness window (if the customer changes
their email between the event and the send, the email is the address-at-event-time) — which
is the correct semantic for a transactional notification anyway: an order-confirmation email
should go to the address on file *when the order was placed*.

The fields are **optional** on every contract (`customerEmail?: string | null`). That keeps
the change additive on the wire — the existing producers, consumers, and tests that predate
this slice still type-check and still pass; a consumer that has not been taught to read the
field simply ignores it.

## 3. The raw-SQL customer-contact reader (no foreign entity import)

The `customer` table is owned by the API gateway's auth module. The boundaries lint
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)) forbids the retail
microservice from importing the gateway's `CustomerEntity` — that would couple two services
across a hard isolation line. The established escape hatch is a **port whose adapter runs
parameterized SQL through the injected `EntityManager`**, reading the shared table directly
without importing anyone else's entity. The retail module already uses this exact pattern
twice:

- `ORDER_CART_READER` — the orders module reads the cart tables (owned by the cart module).
- `RETURN_ORDER_READER` — the returns module reads the order tables (owned by the orders
  module).

This slice adds a third instance per module:

- **`ORDER_CUSTOMER_CONTACT_READER`** (orders module) and **`RETURN_CUSTOMER_CONTACT_READER`**
  (returns module). Both expose one method:

  ```ts
  findContactByCustomerId(customerId: string): Promise<{ email: string | null } | null>;
  ```

  backed by a `CustomerContactReaderTypeormAdapter` running:

  ```sql
  SELECT email FROM customer WHERE id = ?
  ```

The two modules each get their **own** port + adapter rather than sharing one. Orders and
returns are sibling bounded contexts behind the same isolation line, so returns cannot import
the orders module's reader — the same constraint that forced a local copy of the
`retry-then-log-for-replay` helper. The duplication is the deliberate cost of the
bounded-context split; the two adapters are near-identical but each lives wholly inside its
own module.

A `customerId` that resolves no row returns `null` (a tombstoned or otherwise-missing
customer). The reader never throws across the boundary in normal operation; the contact email
column is itself `string | null` to anticipate a future tombstone that nulls PII in place.

### Resolution is best-effort

Each producing use case wraps the lookup in a tiny `resolveCustomerEmail` helper (one local
copy per module) that **never throws**:

- a `null`/absent `customerId` returns `null` with no read at all;
- a missing row returns `null`;
- a reader exception is warn-logged and returns `null`.

This matters because the email is resolved on the **post-commit emit path**. The order (or
RMA transition) has already committed by the time the event is built; a database hiccup while
reading the contact must never fail a completed business operation. The worst case is an
event that ships with `customerEmail: null`, and the consumer falls back to its own recipient
resolution. This mirrors the post-commit eventual-consistency posture used for the
inventory-side cross-service calls (Commit Sale, Restock-from-Return).

## 4. Which producers stamp the email

Nine customer-facing retail events now carry `customerEmail` / `customerLocale`, each
resolved in its producing use case from the relevant `customerId`:

| Event | Producer use case | `customerId` source |
|---|---|---|
| `retail.order.placed` | `PlaceOrderUseCase` | `order.customerId` |
| `retail.fulfillment.shipped` | `ShipFulfillmentUseCase` | the order → `customerId` |
| `retail.fulfillment.delivered` | `MarkDeliveredUseCase` | the order → `customerId` |
| `retail.order.cancelled` | `CancelOrderUseCase` | `order.customerId` |
| `retail.return.requested` | `OpenReturnRequestUseCase` | the RMA's `customerId` |
| `retail.return.authorized` | `AuthorizeReturnUseCase` | the RMA's `customerId` |
| `retail.return.received` | `ReceiveReturnUseCase` | the RMA's `customerId` |
| `retail.return.inspected` | `InspectAndDispositionUseCase` | the RMA's `customerId` |
| `retail.refund.issued` | `IssueRefundUseCase` | the refund's **order** → `customerId` |

The refund case is the notable one: the refund event has no `customerId` of its own, so the
use case resolves the email from the refund's *order* — replacing the old synthetic
`order:<orderId>` recipient with a real address.

Two deliberate exclusions:

- **`inventory.stock.low`** is a system/ops notification, not a customer one — its consumer
  uses the `OPS_NOTIFICATIONS_EMAIL` mailbox, so it carries **no** `customerEmail`. This slice
  does not touch the inventory event.
- **`retail.refund.failed`** is an internal/ops surface (a modeled gateway decline, no
  consumer), so it is left untouched.

## 5. `customerLocale` ships but is `null` (locale deferred)

Every one of the nine contracts also gains `customerLocale?: string | null`, but the
producers set it to **`null`** for now. The column ships ahead of its writer — the same
"ship the shape, fill it later" pattern used elsewhere (e.g. the `payment.refunded_amount_minor`
counter that existed before its writer). When a per-customer locale capability lands, the
producers populate this field and the render-and-dispatch pipeline picks the localized
template via its `locale` input; until then the pipeline defaults locale to `en-US`. Shipping
the field now means that future change is a value fill, not a wire-contract change.

## 6. The `retail.order.cancelled` dual-emit

`retail.order.cancelled` is special: it has **two** distinct consumers on **two** queues.

- **`retail_queue`** — retail's *own* `OrderCancelledConsumer`, the auto-refund-from-cancel
  subscriber that, when `paymentFlaggedForRefund` is `true`, issues the owed refund inline.
  This consumer has existed since the cancel capability landed.
- **`notification_events`** — the notification service's cancellation-confirmation consumer
  (a later capability), which needs the `customerEmail` the event now carries.

Previously the event was emitted **only** onto `retail_queue`. This slice makes
`publishOrderCancelled` **dual-emit**: the same payload goes onto both queues, fired
concurrently (`Promise.all`) through the publisher's two clients so neither destination
blocks the other. The emit stays best-effort and post-commit — the cancel has already
committed, and `payment.flagged_for_refund` remains the durable retry anchor for the refund
leg even if the publish fails ([ADR-032](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)).

This is the same **producer-targets-consumer-queue** routing
([ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md) /
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)) the other notification-bound
retail events use; `retail.order.cancelled` is simply the one event that needs to land on
*both* a retail-internal and a notification queue.

## 7. What is not here

- **The consumers that read these fields** are a later capability — including the new
  cancellation consumer that will bind `retail.order.cancelled` off `notification_events` and
  read `event.customerEmail` for its recipient.
- **Actual locale resolution** — `customerLocale` ships populated `null`.
- **Adapter unit specs** — the raw-SQL readers query a real `EntityManager` (like their
  `ORDER_CART_READER` / `RETURN_ORDER_READER` siblings, which carry no unit specs either); the
  behavior is asserted instead through the producing use cases' specs, which prove each event
  is stamped with the resolved email, and through the gateway end-to-end suites that exercise
  the real database path.
