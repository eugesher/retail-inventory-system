# Replay does not republish events

Request-level idempotency is only safe if a replay is **side-effect-free** beyond
returning the original response. Place Order authorizes a payment, allocates stock,
and publishes `retail.order.placed` (+ the reserved `retail.payment.authorized`).
A client retry that re-ran any of those — or merely re-emitted the events — would
double-charge, double-allocate, or double-notify. The same danger applies to the three
other mutating operations — Capture Payment, Ship Fulfillment, and Issue Refund — which
take money, decrement stock, and (for a refund) write an audit row. This document explains
where the replay short-circuit sits, how an operator observes a replay, and why the events
(and the refund audit) are deliberately **not** re-emitted. It uses Place Order as the
worked example; a dedicated section below covers how the identical contract applies to the
other three.

The governing decision is
[ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md); the requirement and
the body-fingerprint strategy are in
[the idempotency requirement](01-idempotency-q10-restated.md); the persistence substrate
is [the idempotency-key store and its TTL](02-idempotency-key-store-and-ttl.md).

## The replay short-circuit

`PlaceOrderUseCase.execute` (in the retail `orders/` module) runs three ordered steps
before it ever touches the place flow:

1. **Require the key.** A missing `Idempotency-Key` throws
   `ORDER_IDEMPOTENCY_KEY_REQUIRED` → `400`. This is a backstop: the gateway already
   rejects a missing header at the edge (below), so a direct-RMQ caller is the only way
   to reach it.
2. **Fingerprint the canonical body.** The stable logical body — `cartId`,
   `shippingAddress`, `billingAddress`, `paymentMethod`, i.e. the client-controlled
   command minus `correlationId`, `idempotencyKey`, and the owner-injected `customerId`
   — is hashed with the canonical-JSON + SHA-256 helper (see
   [the requirement doc](01-idempotency-q10-restated.md)).
3. **Look the key up FIRST.** `IDEMPOTENCY_STORE.find('place-order', key)` decides the
   branch:
   - **Hit + matching fingerprint → replay.** The stored `OrderView` is returned
     immediately. This `return` happens **before** the private `place(...)` method is
     called at all — and `place(...)` is the sole owner of the whole place flow: the
     owner/state guard, the catalog snapshot, the one-transaction persist + allocate,
     the inline payment authorization, and the post-commit `emitEvents(...)`. Because
     the replay returns before `place(...)`, **none** of those run: no inventory
     allocation, no payment authorization, no order write, and — the point of this
     document — **no event publish**.
   - **Hit + different fingerprint →** `ORDER_IDEMPOTENCY_KEY_REUSED` → `422`. The client
     reused one key for a different body; surfaced loudly, not silently honored.
   - **Miss →** run `place(...)`, then persist
     `(scope='place-order', key, fingerprint, responseStatus=201, responseBody=OrderView)`
     and return the fresh result.

The short-circuit is structural, not a flag checked inside the publisher: the publisher
is simply never reached on the replay path. That is the strongest form of the guarantee
— there is no ordering bug that could let an event slip out on a replay, because the
code that emits is downstream of the `return`.

```
execute(payload)
  ├─ no key?            → 400 ORDER_IDEMPOTENCY_KEY_REQUIRED
  ├─ fingerprint(body)
  ├─ find(scope, key)
  │    ├─ hit, same fp  → return stored OrderView         ◄── replay: NO place, NO events
  │    └─ hit, diff fp  → 422 ORDER_IDEMPOTENCY_KEY_REUSED
  └─ miss
       ├─ place(payload)          ← owner guard, snapshot, tx+allocate, authorize, emitEvents
       ├─ save(record)            ← store the OrderView (outside the tx)
       └─ return fresh OrderView
```

### Two idempotency layers, one ordering

Place Order has a second, **durable** idempotency layer that predates the store: cart
state ([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) §6). A placed
cart is `converted`, so a re-place with a *new* key — a store miss — still resolves to
the order the cart already converted into (via `source_cart_id`) instead of creating a
second one. That path also returns before `emitEvents(...)`. The ordering is: **key
store first; on a miss, the converted-cart guard inside `place(...)` still applies.**
The key store is the fast exact-response replay; cart state is the backstop that
survives even a lost idempotency record (a crash between the place commit and the store
write).

### Why the record is written outside the place transaction

The stored `responseBody` is the complete `OrderView` — including the authorized
payment and the re-read addresses — which is only known **after** the place transaction
commits (payment authorization runs in its own short follow-up transaction). So the
record is persisted after the flow, not inside the transaction. Under genuine
concurrency the "exactly one order per cart" guarantee comes from the
cart-conversion compare-and-swap, not the store: two simultaneous places on one cart
race on the `active → converted` CAS, and the loser rolls back with
`ORDER_CART_NOT_PLACEABLE` before it ever creates an order. The store's own duplicate
handling is a convergence step — `IDEMPOTENCY_STORE.save` swallows an `ER_DUP_ENTRY` on
`(scope, key)`, and an authoritative re-read after the save returns the race-winner's
stored response so both callers converge on one order.

## The four covered operations

The same store-backed replay contract now guards all four mutating operations. Each
`*UseCase.execute` runs the identical three ordered steps — require the key, fingerprint the
canonical body, look the `(scope, key)` pair up first — and returns the
`IIdempotentResult<TView>` envelope so the gateway can set `Idempotent-Replay: true` on a
served replay. The scope namespaces the client key by operation, so one `Idempotency-Key`
reused across two operations can never collide in the store.

| Operation | Scope | Response view | Fresh status | Canonical body (fingerprinted) | Natural backstop |
| --- | --- | --- | --- | --- | --- |
| Place Order | `place-order` | `OrderView` | `201` | `cartId`, `shippingAddress`, `billingAddress`, `paymentMethod` | cart `converted` state |
| Capture Payment | `capture-payment` | `OrderView` | `200` | `orderId`, `amountMinor` | payment already `captured` |
| Ship Fulfillment | `ship-fulfillment` | `FulfillmentView` | `200` | `orderId`, `fulfillmentId`, `trackingNumber`, `carrier` | non-`pending` re-ship 409 + `fulfillmentId`-idempotent commit-sale |
| Issue Refund | `issue-refund` | `RefundView` | `201` | `orderId`, `paymentId`, `amountMinor`, `reason` | already-`issued` match + refundable ceiling |

The canonical body always excludes the transport `correlationId`, the `idempotencyKey`
itself, and the owner/staff-injected identity (the `customerId` for place, the `actorId` +
staff-override flags for the others) — so a retry under a fresh correlation id, or by a
differently-resolved caller, still fingerprints identically. Each `execute` extracts the real
work into a private method (`place` / `capture` / `ship` / `issue`) that owns the whole flow
including its emits; the replay `return` sits upstream of that method, so a replay runs none
of it. On a store miss the work runs, then the response view is persisted under `(scope,
key)`; a concurrent duplicate `save` is swallowed and an authoritative re-read converges both
racers on the winner's stored response (the natural backstop guarantees the same entity
either way).

### Two guarantees that hold for all four on replay

- **No re-execution and no re-emit.** Because the emit lives inside the private work method
  and the replay returns before it, none of the operations re-publish their events on a
  replay: no `retail.order.placed`, `retail.payment.captured`, `retail.fulfillment.shipped`,
  or `retail.refund.issued`. Capture and Ship never re-call the payment gateway, and Ship
  never re-issues `inventory.stock.commit-sale`.
- **Refund never re-audits.** Issue Refund is the one operation that writes an
  `audit_log_entry` on every money movement (the always-audit rule). The replay short-circuit
  sits **before** that audit write, so one logical refund produces exactly one audit row no
  matter how many times the client retries the same key. A replay that re-audited would
  corrupt the audit trail with a phantom second refund event — the precise failure the audit
  exists to rule out.

### The system-initiated refund path

Issue Refund has a second caller besides the staff endpoint: the auto-refund-from-cancel
consumer, which reacts to a cancelled order whose captured payment was flagged for refund.
That path carries no client `Idempotency-Key`, so it synthesizes a **deterministic** one —
`order-cancelled:<orderId>:<paymentId>` — before delegating to the use case. There is at most
one auto-refund per cancelled order, so a redelivered cancellation collapses to a store
replay rather than a second refund. This layers exact replay on top of the pre-existing
refundable-remainder guard (which already no-ops a redelivery once the payment is fully
refunded).

## Observability — telling a replay from a fresh place

Two signals let an operator (and the client) distinguish a served replay from a fresh
execution:

- **The `Idempotent-Replay: true` response header.** The gateway cart controller sets it
  only on a replay. A fresh place carries no such header.
- **The HTTP status.** A fresh place is `201 Created`; a replay returns the stored order
  with `200 OK`. Because the status is dynamic, the place route owns its response via
  `@Res` — the framework's passthrough path would overwrite the status back to the route
  default `201`, so the controller sets `res.status(...).json(view)` explicitly (an error
  thrown before `res.json` still flows through the gateway's exception filters).
- **The `debug` log line.** On a replay the use case logs at `debug`
  (`Idempotent replay — returning the stored place response (no re-execution, no
  events)`), distinct from the `info` `Placing order` a fresh place logs. Turning on
  `debug` shows exactly which requests were served from the store.

The required header is enforced at the edge by a reusable `@IdempotencyKey()` parameter
decorator (in the gateway's `common/`): an absent/blank `Idempotency-Key` yields
`400 { code: 'IDEMPOTENCY_KEY_REQUIRED' }` before any RPC is dispatched. The retail-side
`ORDER_IDEMPOTENCY_KEY_REQUIRED` is the backstop for a caller that bypasses the gateway.

The Capture, Ship, and Refund routes reuse the same decorator and set the same
`Idempotent-Replay: true` header on a replay. Capture and Ship are `200` for both a fresh
call and a replay, so they keep `@HttpCode(200)` and add the header via
`@Res({ passthrough: true })` (the return value stays the body). Issue Refund has a dynamic
status — `201` fresh, `200` on a replay — so, like Place Order, it owns its response via
`@Res` and writes `res.status(...).json(view)` explicitly.

## Why events are not re-emitted

The message bus is **at-least-once**
([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)), and consumers are already
built to tolerate a redelivered event — the notification pipeline dedupes on a delivery
key, and the event store dedupes on a composite UNIQUE
([ADR-035](../../adr/035-event-store-firehose-topic-exchange.md)). So one might ask: if
duplicates are already absorbed downstream, why bother suppressing a re-emit on replay?

Because a **client retry is a different event from a bus redelivery.** Bus redelivery is
the *same* logical publish arriving twice, and the idempotent-consumer pattern collapses
it. A replay that re-ran `emitEvents(...)` would produce a *new* publish for a *second*
logical action that never happened — and not every downstream effect is dedupe-guarded
end-to-end. Re-emitting `retail.order.placed` on every "Pay" double-click would:

- **Double the customer notification.** The order-confirmation email keys its dedupe on
  the delivery, but re-emitting invites a second confirmation for one purchase — exactly
  the "you were charged/emailed twice" experience idempotency exists to prevent.
- **Double the event-store rows for one logical action.** The `domain_event` UNIQUE
  absorbs a redelivery of the *same* event, but two genuinely-separate emits (a fresh
  place and a replay) carry different occurrence context and would land as two rows for
  what is one order placement — corrupting any analytics or audit that counts events.

Suppressing the re-emit keeps "one logical write = one set of events" true regardless of
how many times the client retries. The publish stays best-effort and post-commit
([ADR-011](../../adr/011-notifier-port-and-adapters.md) §7 — an emit failure never fails
the place); the replay simply never enters that code path.

## Related documents

- [The idempotency requirement](01-idempotency-q10-restated.md) — why request-level
  idempotency, the four covered operations, and what "the body" is.
- [The idempotency-key store and its TTL](02-idempotency-key-store-and-ttl.md) — the
  `idempotency_key` table, the `find` / `save` port, and the duplicate-PK behavior the
  concurrent convergence relies on.
- [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) — the decision:
  replay returns the stored response + `Idempotent-Replay: true` before the publisher,
  `422` on key reuse, `400` on a missing key.
- [ADR-011](../../adr/011-notifier-port-and-adapters.md) — the notifier port and the
  best-effort post-commit publish that the replay short-circuits past.
- [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) — the cart→order
  conversion and the cart-state repeat-place backstop the key store layers on top of.
