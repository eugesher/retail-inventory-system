# Triggering the reservation sweep on demand

The inventory service already reclaims stranded holds by itself: a timer ticks every
`RESERVATION_SWEEP_INTERVAL_SECONDS` and calls `SweepExpiredReservationsUseCase`
([`02-sweeper-cron-and-emit-granularity.md`](02-sweeper-cron-and-emit-granularity.md)). This
note describes the second way to invoke that same use case — a staff-only HTTP route,
`POST /api/inventory/reservations/sweep`, fronted by a new RPC on `inventory_queue`.

It changes no sweep behaviour. It adds a *caller*.

## 1. Why an on-demand trigger exists at all

The timer is the correct steady-state mechanism, and nothing here replaces it. But there are
three situations where "the next tick will handle it" is the wrong answer:

**A post-outage backlog.** The broker or the inventory service was down for an hour; carts kept
expiring. When the service comes back, the first tick reclaims at most
`RESERVATION_SWEEP_BATCH_SIZE` rows and then waits a full interval before the next one. With
the defaults (200 rows, 60 s) draining a two-thousand-hold backlog takes ten minutes of
under-selling. An operator who can call the sweep in a loop drains it in seconds.

**An operator verifying a fix.** Someone has just changed a TTL, a batch size, or a stock-level
invariant, and needs to know the reclaim path still works. Waiting up to a full interval to
find out — and then reading the answer out of a log line rather than a response body — is a
poor debugging loop. The endpoint returns the counters directly.

**A demo or a walkthrough.** Watching `available` climb back on a dashboard, on cue, is worth
more than a promise that it will climb within the minute.

None of these justify a second sweep implementation, and none of them get one.

## 2. One implementation, two callers

```
ReservationSweepScheduler ──┐
  (infrastructure/scheduling)│
                             ├──▶ SweepExpiredReservationsUseCase.execute({ batchSize?, correlationId?, actorId? })
StockController              │
  @MessagePattern(          ─┘
    'inventory.reservation.sweep')
```

The controller handler is a one-line delegation. It holds no logic, no clamping, no
try/catch — the same posture as the other twelve `@MessagePattern` handlers on
`stock.controller.ts`. Everything the sweep does — the advisory scan, the in-transaction
`status = 'active'` re-read, the bounded chunking, the per-chunk `withInvalidation`, the
negative `release` ledger row, the per-hold `inventory.stock.released` — is described in
[`01-reservation-sweeper-design.md`](01-reservation-sweeper-design.md) and is untouched by this
change.

**The single behavioural difference is `actorId`.** A scheduled tick has no human behind it and
passes `null`; the gateway folds `@CurrentUser().id` into the command
([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)), so every `release` row the
manual invocation appends to `stock_movement` names the staff member who pressed the button.
Afterwards, `GET /api/inventory/variants/:variantId/movements` distinguishes the two: a row with
`type: 'release'`, `reasonCode: 'expired'`, and a non-null `actorId` was reclaimed by a person;
the same row with a null `actorId` was reclaimed by the timer.

### The result shape moved to `libs/contracts`

`SweepExpiredReservationsUseCase` used to declare its own result interface beside itself,
because until this change nothing crossed a wire. It now returns `IReservationSweepResult` from
`libs/contracts/inventory/reservation/`, and the local interface is gone. One shape, defined
once: the RPC response, the gateway response body, and the timer's own return value are the
same type, so a field added to one can never be missing from another.

## 3. The contract

| Method | Path | Body | Auth | Response |
| --- | --- | --- | --- | --- |
| `POST` | `/api/inventory/reservations/sweep` | `{ batchSize? }` | bearer + `inventory:adjust` | `200 { scanned, expired, skipped, durationMs }` |

**The permission is `inventory:adjust` — the same gate as the manual release.** Both operations
do the same thing to the books: they take units out of `quantity_reserved` and hand them back to
`available`, and both append a `release` ledger row. If a principal may free one hold by id, it
may free the expired ones in bulk; the sweep is *less* dangerous, because it only touches holds
whose TTL has already elapsed. No new `PermissionCodeEnum` member was minted — that would have
implied a distinct authority that does not exist
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)). The code is staff-only
by construction: customer tokens carry no `permissions` claim, so no customer can reach the
route, and `JwtAuthGuard` → `RolesGuard` → `PermissionsGuard` run globally
([ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md)). A staff token without the code gets a
`403`.

The route is declared **before** `POST /api/inventory/reservations/:reservationId/release` in
`inventory.controller.ts`. The two cannot actually collide — `reservations/sweep` is two path
segments, the release route is three — but a literal segment placed ahead of its `:param`
sibling is the ordering that stays correct if either route ever changes shape, and a reader
should not have to count segments to convince themselves.

**`scanned = expired + skipped`, always.** Every candidate the scan returned was either expired
by this invocation or declined by it. Nothing else can happen to a candidate: an unknown or
non-`active` or TTL-refreshed row is counted as `skipped`, never dropped and never raised. The
identity is what makes the response readable (§6), and it holds by construction, not by luck.

## 4. Why `batchSize` is clamped, not validated

The DTO is deliberately half a validator:

```ts
@IsOptional() @IsInt() @Min(1)
public batchSize?: number;
```

There is no `@Max(...)`. A `10_000` is accepted at the edge and clamped by the service into
`[1, RESERVATION_SWEEP_BATCH_SIZE]`.

The reasoning is about *where a fact lives*. `RESERVATION_SWEEP_BATCH_SIZE` is an operational
property of the inventory microservice — how much work one invocation may do before it yields —
and it is tuned per environment through an env var. A maximum hardcoded in a gateway DTO would
be a second copy of that number, in a different deployable, that nobody updates when the
service is retuned. The first operator to raise the service's ceiling would be rejected by a
gateway that had never heard about it.

So the gateway guards *shape*, which is a request-level fact: `"batchSize": "many"` and
`"batchSize": 0` are malformed requests and get a `400`. Magnitude is a service-level fact,
and the service enforces it silently — the clamp is documented in the DTO comment, the
`.http` file, and the OpenAPI description, so a caller who asks for more than the ceiling can
tell from the `scanned` count that it was lowered.

The split has one seam, and it is worth stating rather than enumerating around. **`"batchSize":
null` is a shape the gateway does not reject**: `@IsOptional()` skips a property's validators
for `null` as well as for `undefined`, and `whitelist` does not strip a decorated field. So
`null` arrives at the use case, where `Math.trunc(null)` is `0` — not `NaN` — and a naive
`[1, ceiling]` clamp would lift it to a **one-row sweep that reports success**. The service
therefore treats *every* non-finite-number as "no override" and falls back to the ceiling,
rather than testing `=== undefined`. The same line covers the direct RPC, which reaches
`SweepExpiredReservationsUseCase` with no pipe in front of it at all.

The clamp is one-directional by design: `RESERVATION_SWEEP_BATCH_SIZE` is a **ceiling**, not a
default. An operator may sweep fewer rows than configured (to probe carefully); an operator may
never make one invocation do more work than the service was configured to allow.

## 5. Why there is no `Idempotency-Key`

Four writes in this system require an `Idempotency-Key` header
([ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md)): place order, capture
payment, issue refund, and open return. Each is a *money- or stock-moving write whose replay
would double the effect* — capturing a payment twice takes the money twice. The header, the
`idempotency_key` row, and the body fingerprint exist to make a retry a replay.

The sweep needs none of that, because it is idempotent by construction rather than by
bookkeeping. The set it acts on is defined by a predicate — `status = 'active' AND expires_at <
now` — and acting on a row removes it from that set. A second invocation, a retried HTTP
request, or two operators clicking at once all find the same holds already `expired` and skip
them; the in-transaction re-read (`row.status !== ACTIVE → skip`) is the same guard that makes
two concurrent *timers* safe. No counter moves twice. The natural-key idempotency the inventory
writes already carry is exactly why ADR-036 put the `idempotency_key` table in retail and
nowhere else.

Adding a key here would buy nothing and cost a required header on a debugging tool.

## 6. Reading the response

```json
{ "scanned": 7, "expired": 7, "skipped": 0, "durationMs": 42 }
```

Seven stranded holds existed and this invocation reclaimed all seven. `available` for their
variants is now higher, seven negative `release` rows carry your `actorId`, and seven
`inventory.stock.released` events were published.

```json
{ "scanned": 7, "expired": 0, "skipped": 7 }
```

Seven candidates were found and none was expired. This is **not** a failure. Between the scan
and the transaction, every one of them stopped qualifying: a shopper edited the cart (a Reserve
refreshed `expiresAt`), a Place allocated the hold, a cart Remove released it, or another sweep
— the timer, or a colleague's click — got there first. The counters are correct; there was
simply nothing left to do. A steady stream of these means your manual sweeps are racing the
timer, which is harmless.

```json
{ "scanned": 0, "expired": 0, "skipped": 0 }
```

No hold anywhere is both `active` and past its `expiresAt`. This is the healthy steady state,
and it is what a well-tuned timer produces on every tick. If you expected a reclaim, check that
enough wall-clock time has passed: `isExpired` uses a strict `<`, so a hold whose `expiresAt`
equals the sweep's `now` is not yet expired.

A `409` with code `INVENTORY_STOCK_WRITE_CONFLICT` means the sweep exhausted `OCC_RETRY_ATTEMPTS`
against a `StockLevel` some checkout kept moving. It is the honest answer — the system is under
write contention — and retrying is the correct response. Chunks committed before the failing one
stay committed; the next invocation picks up the rest.

## 7. Exercising it

Both request libraries carry the two calls, and both name them after the controller route:

- [`http/kulala/inventory.http`](../../../http/kulala/inventory.http) — `sweepReservations`
  (no body) and `sweepReservationsCustomBatch` (`{ "batchSize": 5 }`). Run the `login` block
  first; it captures the seeded admin's bearer token into `@accessToken`.
- [`http/posting/inventory/`](../../../http/posting/inventory) — `sweep-reservations.posting.yaml`
  and `sweep-reservations-custom-batch.posting.yaml`, the Posting twins. Run the subcollection
  top-to-bottom so `login` populates `$accessToken` first.

To watch it reclaim something rather than report a clean table: add a line to a cart (which
reserves), let `RESERVATION_TTL_MINUTES` elapse, then call the route. `expired` will be at
least `1`, and `GET /api/inventory/variants/1/movements` will show the negative `release` row
with `reasonCode: 'expired'` and your staff id in `actorId`.

The same trip in `.http` form also corrects a claim both libraries used to make: that the manual
by-id release is the only tool that frees a hold. It is not, and it has not been since the timer
landed. A hold is freed by an explicit release, by cart conversion at order placement, or by the
TTL sweep.

## Cross-links

- [`01-reservation-sweeper-design.md`](01-reservation-sweeper-design.md) — the sweep itself: the
  advisory scan, the two bounds, and the race it settles without a lock.
- [`02-sweeper-cron-and-emit-granularity.md`](02-sweeper-cron-and-emit-granularity.md) — the
  timer that is the sweep's other caller, and why it emits one event per hold.
- [`07-request-libraries-audit-and-sweep.md`](07-request-libraries-audit-and-sweep.md) — how to
  run these two requests in either library, and why a second sweep reports `expired: 0`.
- [`08-sweep-vs-release-race-and-e2e-coverage.md`](08-sweep-vs-release-race-and-e2e-coverage.md)
  — the end-to-end suite behind this route, and the race it settles against a cart Remove Line.
- [ADR-038](../../adr/038-reservation-ttl-sweep-and-bounded-batches.md) — the decision record for
  the whole capability, including the batch-size ceiling this route may lower but not raise.
- [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) — the four writes that do
  require an `Idempotency-Key`, and the optimistic-retry budget whose exhaustion is the `409`.
- [ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md) and
  [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) — the global guards and
  the permission model behind the `inventory:adjust` gate.
- [ADR-009](../../adr/009-port-adapter-at-the-gateway.md) — the gateway seam: the controller and
  the use case depend on `INVENTORY_GATEWAY_PORT`; only `InventoryRabbitmqAdapter` holds a
  `ClientProxy`.
- [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) — folding `@CurrentUser().id`
  into the command at the gateway.
