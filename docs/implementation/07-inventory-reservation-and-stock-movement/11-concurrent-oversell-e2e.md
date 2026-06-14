# Locking the reservation capability end-to-end (the concurrent-oversell proof)

The reservation + stock-movement capability is now locked through the API gateway
by four end-to-end suites under `test/`. The headline is
**`test/concurrent-oversell.e2e-spec.ts`**: two carts race for the last unit of a
freshly-provisioned variant, exactly one wins, the loser gets a structured
`409 INVENTORY_OUT_OF_STOCK` with `available: 0`, and after the winner places, the
final stock state is consistent down to the ledger — proving the no-oversell
guarantee holds under real HTTP-level contention, not just in unit tests.

These suites add **no production code**. They exercise the behaviors decided in
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
(the no-oversell guard, the optimistic write protocol, allocate-inside-the-place-
transaction, and the append-only audit ledger) over the real wiring built across
the sibling docs:
[04-no-oversell-invariant-and-occ.md](04-no-oversell-invariant-and-occ.md) (the
guard + the version-checked retry),
[05-add-to-cart-cross-service-reserve.md](05-add-to-cart-cross-service-reserve.md)
(reserve on add/change, release on remove),
[06-allocate-on-place.md](06-allocate-on-place.md) (allocate at place time),
[08-receive-adjust-now-write-movements.md](08-receive-adjust-now-write-movements.md)
and [09-transfer-stock-two-movements.md](09-transfer-stock-two-movements.md) (the
other ledger writers), and
[10-movements-audit-endpoint-and-http-file.md](10-movements-audit-endpoint-and-http-file.md)
(the audit read the suites assert through).

## The four suites

| Suite | Boots | What it locks |
| --- | --- | --- |
| `test/cart-reserve-release.e2e-spec.ts` | gateway + retail + inventory + catalog | Reserve on add, absolute re-reserve on change, release on remove, per-variant release isolation, and the out-of-stock `409` that leaves the cart line-less. |
| `test/place-order-allocates.e2e-spec.ts` | gateway + retail + inventory + catalog | Place converts each line's hold reserved → allocated (on-hand unchanged), writes exactly one negative `allocation` movement per order line referencing the order, and a repeat-place appends none. |
| `test/concurrent-oversell.e2e-spec.ts` | gateway + retail + inventory + catalog | The canonical race (below), plus a second act proving the release path frees the unit for the loser under the same contention. |
| `test/inventory-movements-audit.e2e-spec.ts` | gateway + retail + inventory + catalog | The full ledger timeline (types, signs, reason codes, reference pairs, actor ids), the `?type` / `?from` / `?to` filters, paging, and the `inventory:read` permission gates. |

Every suite that consumes stock **self-provisions disjoint fixtures**: it
registers its own product + variant + price, publishes it, and `receive`s exactly
the quantity it needs at `default-warehouse`. Each suite uses its own slug/SKU
family (`e2e-cart-rr-*`, `e2e-place-alloc-*`, `e2e-oversell-*`, `e2e-audit-*`), so
the suites never touch the shared seeded variants 1–4 that other suites read, and
they cannot corrupt one another's state inside the single shared DB the e2e pass
runs against.

> **Why publish + a ~1.5 s settle in provisioning.** A price's `valid_from` is
> stored at second granularity (`TIMESTAMP(0)`), so a freshly-set immediate price
> can round *up* and momentarily sit one second in the future — which both the
> publish precondition probe and the Add-to-Cart price snapshot (`asOf = now`)
> would read as "no active price". The provisioning helper waits just over a
> second before publishing/adding so that rounded second has elapsed.

> **Why provisioning polls the DB for the `stock_level` row before `receive`.** The
> `catalog.variant.created` event triggers auto-init asynchronously (it creates a
> zeroed `stock_level` row). If `receive` lazily created the row at the same instant
> auto-init inserted it, the two would race a duplicate-key `INSERT` on the UNIQUE
> `(variant_id, stock_location_id)`. Polling for the auto-init row first removes the
> race deterministically.

## Running the concurrency proof

The suite must be green and **stable across 5 consecutive runs**. This repository
pins Jest 29, whose filter flag is `--testPathPattern` (singular).

```bash
# One-off (infra must already be up — docker compose):
yarn test:e2e:run --testPathPattern concurrent-oversell

# The 5× stability loop after one infra reload (the exit-criteria command):
yarn test:infra:reload && \
  for i in $(seq 5); do \
    yarn test:e2e:run --testPathPattern concurrent-oversell || break; \
  done
```

The suite self-provisions a fresh variant (stamped slug) on every run, so it stays
green across repeated runs against the same DB without a reload between them — the
reload above is only to start from the canonical seeded baseline.

It is also covered by the full pass: `yarn test:e2e` reloads infra, migrates,
seeds, then runs all 21 suites sequentially (`jest -i`) against the one shared DB.

## How to read the concurrency assertions

The suite is written so its result never depends on luck, timing, or broker
delivery. Three deliberate choices make that true.

### Winner-agnostic outcome sums

Both adds are fired with `Promise.all` so they are in flight simultaneously and
genuinely contend for the single `stock_level` row. The test then **sums the
outcomes** rather than assuming which racer wins:

```ts
const wins = outcomes.filter((o) => o.status === 200);       // add-to-cart is @HttpCode(OK)
const conflicts = outcomes.filter((o) => o.status === 409);
expect(wins).toHaveLength(1);
expect(conflicts).toHaveLength(1);
expect(conflicts[0].body.code).toBe('INVENTORY_OUT_OF_STOCK');
expect(conflicts[0].body.details.available).toBe(0);
```

(Note: `POST /api/cart/:id/lines` returns **200**, not 201 — the gateway route is
`@HttpCode(OK)` because it returns the updated cart, not a freshly-created
resource.) The winner is then identified as whichever racer got the `200`, and the
loser as the other — neither is hard-coded. With only two racers the loser's
outcome is *deterministically* `OUT_OF_STOCK`, not a transient write conflict:
once the winner commits, every reload inside the loser's bounded retry reads
`available = 0` and the `StockLevel.reserve` guard throws immediately, before any
further compare-and-swap.

The `409` carries the structured error end to end — the inventory domain throws
`OUT_OF_STOCK` with `{ available }`, the inventory RPC filter shapes it as
`{ statusCode, message, code, details }`, the retail microservice passes the
`RpcException` through verbatim, and the gateway's `throwRpcError` forwards `code`
and `details` into the HTTP body. So the storefront can branch on the stable
`code` and show "only 0 left" without re-reading stock.

### DB-backed reads, never event spies

Every assertion reads **persisted state through the public API**, never a broker
side effect:

- the **public stock read** `GET /api/inventory/variants/:id/stock` — there is
  deliberately no reservation read API, so a hold is observed indirectly:
  `totalAvailable` drops while `totalOnHand` stays put (a reservation never moves
  on-hand), and the per-location `quantityReserved` / `quantityAllocated` carry the
  exact counters; and
- the **movements ledger** `GET /api/inventory/variants/:id/movements`, which is
  uncached.

The reserved-surface events (`inventory.stock.reserved` / `.allocated` /
`.released`) are intentionally **not** asserted. They are fire-and-forget,
post-commit, best-effort emits with no consumer yet; asserting their delivery
timing would couple the proof to the broker and make it flaky. The DB is the
source of truth, so the DB is what the suite reads.

> The stock read is cache-aside, but every reservation write routes through
> `withInvalidation`, which wipes the variant's cache **after** the commit
> (ADR-023). So a read taken right after a reserve/release/allocate reflects the
> committed counters — no sleep needed. See
> [07-cache-key-bump-v2-to-v3.md](07-cache-key-bump-v2-to-v3.md).

### What "consistent final state" means

After the winner places, the suite asserts the state in two complementary terms:

- **Counters** — `quantityOnHand = 1`, `quantityAllocated = 1`,
  `quantityReserved = 0`, `available = 0`, and every counter `>= 0` (a negative
  counter is exactly what an oversell bug would surface).
- **Ledger** — the variant's whole timeline is *exactly two rows*: the provisioning
  `receipt` (+1) and the winner's `allocation` (−1). A reservation writes no ledger
  row, so the winner's successful hold is invisible here and the loser's failed add
  left nothing — no orphaned hold, no stray ledger entry. If two units had been
  oversold, or a phantom hold had leaked, this count would not be 2.

## What the suites deliberately do NOT cover

- **TTL-expiry by a sweeper.** No sweeper exists — `Reservation.expire()` has no
  caller yet. Only the *inline* expiry policy is observable (Allocate refreshes a
  wall-clock-stale-but-still-held hold and commits it, never surfacing
  `RESERVATION_EXPIRED` — see
  [06-allocate-on-place.md](06-allocate-on-place.md)). A sweeper-driven expiry
  scenario waits for the sweeper capability.
- **Cart abandonment (release-all-by-cart over HTTP).** There is no abandonment
  producer in the system — the purge flow that flips a cart `active → abandoned`
  belongs to a later capability, so there is no end-to-end vehicle to trigger a
  whole-cart release. The release-all-by-cart codepath is unit-locked inventory-side
  instead (`release-reservation.use-case.spec.ts`). The e2e suites exercise the
  per-line release through the cart Remove route, which travels the identical
  release codepath (reason `cart-removed`).
- **Manual release by reservation id over HTTP.** There is no reservation read API,
  so a suite has no deterministic in-process source for a reservation id. That
  endpoint (`POST /api/inventory/reservations/:reservationId/release`) is exercised
  in the `http/inventory.http` flow and in the inventory unit specs; the audit suite
  produces the same `release` ledger row via the cart Remove route instead.

## Troubleshooting

- **Stock-drift assertion failures (a count is off by what an earlier run held).**
  The e2e pass runs sequentially against one shared DB; a partial or interrupted
  earlier run can leave holds or counters in a non-baseline state. Reset to the
  canonical seeded baseline:

  ```bash
  yarn test:infra:reload   # down -v → up → migrate → seed
  yarn test:e2e:run        # or a --testPathPattern subset
  ```

  The self-provisioned suites are immune to *each other's* drift (disjoint
  fixtures), but a dirty DB from an aborted run is the usual cause of a surprise
  failure — a reload is the fix.
- **`Timed out waiting for auto-init stock_level row`.** The inventory microservice
  or its `catalog.variant.created` consumer is not up, or RabbitMQ is unreachable.
  Confirm `docker compose ps` shows mysql / redis / rabbitmq running and that the
  suite booted the inventory app.
