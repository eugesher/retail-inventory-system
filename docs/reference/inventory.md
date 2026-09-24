# Inventory

This file covers what the inventory `stock` module
(`apps/inventory-microservice/src/modules/stock/`) does today that its names and types do not say.
It describes the three models and the ledger, the write protocol every counter change goes through,
the multi-line RPCs retail drives, the availability cache, the reservation sweep, and how they fail.
Paths below are relative to that folder unless they start at the repository root. The rationale
lives in the ADRs:

- [ADR-027](../adr/027-stocklevel-running-totals-and-stocklocation.md): running totals and locations.
- [ADR-030](../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md): the `Reservation`
  lifecycle, the ledger, and no-oversell.
- [ADR-031](../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md) and
  [ADR-032](../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md): Commit Sale and Restock
  From Return.
- [ADR-057](../adr/057-cancel-allocation-needs-an-operation-identity.md): the Cancel Allocation key.
- [ADR-038](../adr/038-reservation-ttl-sweep-and-bounded-batches.md): the sweep.
- [ADR-023](../adr/023-cache-invalidate-post-commit-by-type.md) and
  [ADR-049](../adr/049-the-port-methods-nothing-calls.md): the two-operation cache port.
- [ADR-045](../adr/045-one-occ-retry-protocol.md): the OCC retry.
- [ADR-063](../adr/063-unit-of-work-for-stock-orders-returns.md): lists each use case's transaction
  shape.

The routing keys, use cases and invariants are in
[`README.md` §4](../../README.md#inventory-inventory-microservice) and
[§5](../../README.md#inventory-invariants). Payload rules and the ledger's writer table are in
[`wire-contracts.md`](wire-contracts.md#inventory). The code-to-status table is
`presentation/inventory-rpc-exception.filter.ts`.

## `StockLevel`

- **`available` can go negative.** `changeOnHand` refuses only a negative `quantityOnHand`. It does
  not refuse an on-hand below what is reserved and allocated. An Adjust with a negative delta, or
  the source leg of a Transfer, can therefore leave `available < 0` at a location with live holds or
  allocations (`domain/stock-level.model.ts`, `StockLevel.changeOnHand`). The spec pins this:
  `available` "can be negative when commitments exceed on-hand". Reserve and allocation never push
  `available` below zero. They check `quantity ≤ available` first.
- **Each over-ask fails in one of two ways, and the way it fails says whether a caller could have
  caused it.** A typed `InventoryDomainException` becomes a `4xx` through the filter. A plain
  `Error` is counter drift and surfaces as a `500`:

  | Mutator                | Asks for more than… | Fails with                  |
  | ---------------------- | ------------------- | --------------------------- |
  | `changeOnHand` (−)     | on-hand             | `409 STOCK_RESULT_NEGATIVE` |
  | `reserve`              | `available`         | `409 OUT_OF_STOCK`          |
  | `allocateDirect`       | `available`         | `409 OUT_OF_STOCK`          |
  | `releaseAllocated`     | allocated           | `409 STOCK_RESULT_NEGATIVE` |
  | `commitSale`           | on-hand             | `409 STOCK_RESULT_NEGATIVE` |
  | `commitSale`           | allocated           | plain `Error` (`500`)       |
  | `releaseReserved`      | reserved            | plain `Error` (`500`)       |
  | `allocateFromReserved` | reserved            | plain `Error` (`500`)       |

  A quantity that is not a positive integer is a plain `Error` in every mutator except
  `changeOnHand`, which rejects only a non-integer delta.

  The use cases check a quantity first, so a bad quantity from a caller reaches them as a typed
  `400`, not as the domain's plain `Error`. `OUT_OF_STOCK` carries the live `available` in
  `details`.

- **A write persists absolute counter values under a version check.**
  `StockTypeormRepository.persistStockLevelChange` writes all three counters from the in-memory
  level with `SET …, version = version + 1 WHERE id = ? AND version = ?`, where the expected version
  is the one read before the first mutation. Lines that share a level mutate one in-memory instance,
  so the row is written once and its version moves by one, however many lines touched it
  (`application/use-cases/reservation-mutation.ts`, `loadDistinctLevels`). A missing level is built
  zeroed and inserted. A lost `UNIQUE (variant_id, stock_location_id)` race on that insert raises the
  same `StockWriteConflictError` as a lost compare-and-swap.
- **The foreign keys are real but live only in the migrations.** `stock_level`, `reservation` and
  `stock_movement` reference `product_variant` and `stock_location` (and `reservation` references
  `cart`), all `ON DELETE RESTRICT`. The entities map these columns as plain scalars with no
  relation, because inventory may not import the catalog or retail entities
  (`migrations/1780860153719-ReplaceProductStockWithStockLevelAndLocation.ts`,
  `migrations/1781309334478-CreateReservationTable.ts`,
  `migrations/1781338464522-CreateStockMovementTable.ts`).

## Locations

- **Only Receive, Adjust, Transfer and Reserve check the location**
  (`application/use-cases/stock-location.guard.ts`, `requireActiveLocation`). An unknown id is
  `404 STOCK_LOCATION_NOT_FOUND`, and a deactivated one is `409 STOCK_LOCATION_INACTIVE`. Not-found
  is checked first. The check runs before the transaction opens.
- **Allocate, Cancel Allocation, Commit Sale and Restock From Return check nothing about the
  location.** A deactivated location is accepted. An unknown one gets a zeroed level built for it,
  and the request fails on whatever that level trips first:
  - Allocate: `409 OUT_OF_STOCK`.
  - Cancel Allocation: `409 STOCK_RESULT_NEGATIVE`.
  - Commit Sale: the allocated-drift `Error`, a `500`.
  - Restock From Return: the `stock_level` foreign key on insert, a `500`.
- **A transfer to its own source is `400 TRANSFER_SAME_LOCATION`.** A transfer moves on-hand only;
  the source's reserved and allocated counters stay where they were (see the `available` note
  above).

## `Reservation`

The lifecycle, the all-statuses UNIQUE triple, `reactivate`, the strict `<` expiry and the
refresh-then-commit rule are in ADR-030 §1. Beyond them:

- **A re-reserve at the same quantity writes only the hold row.** `ReserveStockUseCase.reserveOnce`
  persists the level only when a counter moved. A delta of zero refreshes the TTL and saves the
  reservation, with no `stock_level` write and so no version check anywhere. The reservation save
  is a plain TypeORM `save` in every path. What serialises two writers of one hold is the
  version-checked level write that every counter-moving path makes before it saves the row
  (`infrastructure/persistence/reservation-typeorm.repository.ts`,
  `ReservationTypeormRepository.save`).
- **A lost insert race on the triple converges.** The repository translates `ER_DUP_ENTRY` into
  `StockWriteConflictError`. The retry re-reads the row that won and takes the refresh or reactivate
  path instead of inserting.
- **Reserve on a `committed` hold is `409 RESERVATION_INVALID_STATE`.** Retail reaches it in normal
  use: Add Line and Change Line Quantity reserve before the cart checks that it is still active
  ([`retail-cart.md`](retail-cart.md#holding-stock)).
- **A lapsed hold is still a hold.** Its row stays `active` and its quantity stays in
  `quantity_reserved` until something acts on it. Reserve refreshes it like any active hold. Allocate
  refreshes and then commits it. The sweep expires it.
- **Release re-checks the status inside its transaction.** The ids are resolved before the
  transaction. Then `Reservation.release` raises `409 RESERVATION_INVALID_STATE` for a hold that a
  sweep, an Allocate or another Release has moved in the meantime. This is the case even for the
  `cartId` selector, whose empty match is otherwise a no-op. The whole call fails and nothing is
  released (`application/use-cases/release-reservation.use-case.ts`,
  `ReleaseReservationUseCase.releaseAll`). The sweep treats the same case as a skip.

## `StockMovement`

- **The sign rule is checked on load as well as on write.** `StockMovement.reconstitute` runs the
  same check as `record`, so a stored row whose sign contradicts its type throws when it is read
  (`domain/stock-movement.model.ts`). The record is `Object.freeze`d.
- **`occurredAt` is the Node clock when the use case built the row**, not the commit time. The
  mapper writes it explicitly. In a retried write it is the time of the attempt that won.
- **`movement_dedupe_key` is not mapped on the entity.** It is a stored generated column, and TypeORM
  must not write it (`infrastructure/persistence/stock-movement.entity.ts`). It is non-null for
  `sale` and `return` rows, keyed on reference plus `(variant, location)`, and for `release` rows
  that carry an `operation_key`. Only Cancel Allocation sets that key. The UNIQUE on it,
  `UC_STOCK_MOVEMENT_DEDUPE`, is what makes the three ledger-deduped writes idempotent
  (`migrations/1784010000000-AddStockMovementOperationKey.ts`).

## The write protocol

Every counter change runs as
`stockCache.withInvalidation(() => runWithStockWriteRetry(deps, attempt, ctx), resolveItems)`
(`application/use-cases/stock-mutation.ts`).

- **Each attempt opens its own transaction.** `runWithStockWriteRetry` passes `runWithOccRetry` a
  thunk that calls `runInTransaction`. A retry therefore reads a fresh snapshot, and an attempt that
  lost leaves nothing behind. Only a `StockWriteConflictError` is retried. Exhaustion becomes
  `409 STOCK_WRITE_CONFLICT`, and any domain rejection propagates at once.
- **The ledger append comes after the version-checked level write.** A lost compare-and-swap throws
  before any movement is written, so a successful write appends exactly one movement per line
  however many attempts it took.
- **The cache is cleared after the commit, and only on success.** `withInvalidation` awaits the work
  before it resolves the items. A rejected write clears nothing.
- **The retry trace names the row that lost.** It takes `variantId` / `stockLocationId` from the
  conflict, not from the caller's context, and does not read back the winning version.

## The multi-line RPCs

Allocate, Cancel Allocation, Commit Sale and Restock From Return share one shape: validate every
line, load each distinct level once, compute every line in memory, then write. A rejection on any
line throws before the first write, so a request either applies in full or not at all. None of them
touches the reservation table except Allocate.

### Two lines on one `(variant, location)`

What happens depends on the operation:

| Operation           | Outcome                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Commit Sale         | `400 RESERVATION_QUANTITY_INVALID` (`requireDistinctLevels`)                                                          |
| Restock From Return | `400 RESERVATION_QUANTITY_INVALID` (`requireDistinctLevels`)                                                          |
| Allocate            | summed correctly when the cart holds nothing for that level; applies the hold once per line when it does (see below)  |
| Cancel Allocation   | the second line's `release` row collides with the first on the dedupe key; the call reports success, releases nothing |

- **Allocate re-reads the hold for each line.** `AllocateStockUseCase.allocateOnce` calls
  `findByKey` per line, and the holds are saved only after the loop. A second line on the same
  level finds the same `active` hold and commits it again. `quantity_reserved` then drops by the
  hold's quantity once per line. With nothing else reserved on the level, that is the drift `Error`
  (`500`). With other carts' holds on it, it takes their units out of the counter.
- **Cancel Allocation treats every duplicate-key error as a replay.** Both lines share one
  `operationKey`, so the second `release` row has the same `movement_dedupe_key` as the first. The
  catch in `CancelAllocationUseCase.execute` returns `{ cancelled: <line count> }`, and the
  transaction has rolled back.

Retail never sends either shape. A cart merges lines by variant, and retail sends no location, so
each order line is its own level. Both RPCs are reachable directly on the bus.

### Replays of Commit Sale and Restock From Return

Three checks meet a second delivery of one `fulfillmentId` or `returnRequestId`:

1. `existsByReference` before any transaction. This is the sequential replay, and it opens no
   transaction and clears no cache.
2. The same probe inside the attempt's transaction, before the levels are read. A delivery whose
   transaction starts after the winner committed sees the winner's row here and throws
   `LedgerReplayError` (`application/use-cases/ledger-replay.error.ts`). Without it, Commit Sale
   would read an allocated count the winner had already consumed and fail on the drift `Error`.
3. `UC_STOCK_MOVEMENT_DEDUPE` on the append, for a writer both probes missed.

All three return the same result: the request's own lines, echoed back. Nothing is decremented or
credited, and no event is published. A `LedgerReplayError` is not a `StockWriteConflictError`, so it
is never retried. The e2e suite runs both RPCs twice at once against MySQL
(`test/concurrent-commit-sale.e2e-spec.ts`).

### Cancel Allocation

- **A blank or absent `operationKey` is `400 RESERVATION_QUANTITY_INVALID`**, raised before any
  write (ADR-057 §3).
- **A replay answers `{ cancelled: <line count> }`**, the same shape as a first delivery, and
  publishes nothing.
- **Its `inventory.stock.released` event always says `order-cancelled`.** The payload's free-form
  `reason` goes only into the movement's `reason_code`.

## The availability cache

`infrastructure/cache/stock.cache.ts`, `StockCache`. The key shape is in
[`README.md` §12](../../README.md#key-convention). The port offers `getOrLoad` and
`withInvalidation` and nothing else (ADR-049).

- **A failed cache read skips the cache entirely for that request.** `get` reports whether Redis
  answered. If the outer read failed, `getOrLoad` calls the loader directly. It does not take the
  single-flight slot and does not write back. If the read inside the single-flight leader fails, the
  leader loads without writing back. One outage costs one `warn` line per request, not two
  (`StockCache.getOrLoad`).
- **The TTL comes from `CACHE_TTL_MS_PRODUCT_STOCK`**, default `60000`. The code falls back to
  `60000` itself when the config has no value.
- **The jittered TTL is floored at 1 ms.** keyv treats a TTL of `0` as "never expires", so a small
  configured TTL plus a negative jitter would otherwise produce a permanent entry
  (`StockCache.jitterTtl`).
- **Invalidation is one prefix delete per distinct `variantId`**, whatever locations the write
  touched. The per-item `stockLocationId` is not used.
- **A failed invalidation is a `warn`.** The entry lives until its TTL, and the write still
  succeeds.

## The reservation sweep

Batch, chunk, skip and clamp rules are in ADR-038; the timer's log lines are in
[`README.md` §13](../../README.md#13-background-jobs). Beyond them:

- **`ReservationSweepScheduler` skips a tick while the previous sweep is still running.** A
  per-instance `sweeping` flag, reset in `finally`, makes an overlapping tick log at `debug` and
  return. It is per process: two inventory replicas each run their own timer, and the use case's
  re-read makes that safe. The first tick fires one full interval after boot
  (`infrastructure/scheduling/reservation-sweep.scheduler.ts`).
- **`onModuleDestroy` must delete the interval.** The handle comes from a raw `setInterval`, which
  outlives the Nest container and keeps the event loop alive. A Jest worker would never exit.
  `deleteInterval` is guarded by `doesExist`, because it throws on an unknown name.
- **The use case lets an exhausted retry escape.** `STOCK_WRITE_CONFLICT` from one chunk aborts the
  rest of that invocation. Earlier chunks stay committed. The scheduler logs the failure at `warn`,
  and the RPC returns it to the caller.
- **A requested `batchSize` that is not a finite number falls back to the configured ceiling.** This
  includes `null`, a string and `NaN`. A number is truncated and clamped to `[1, ceiling]`
  (`application/use-cases/sweep-expired-reservations.use-case.ts`,
  `SweepExpiredReservationsUseCase.resolveLimit`).

## Events

- **Every event is built by the use case after the commit, and a publish failure is only logged.**
  `StockLevel`, `Reservation` and `StockLocation` are plain classes with no domain events. An event
  is evidence that a write happened. Its absence says nothing.
- **`inventory.stock.low` goes to `notification_events`. The other nine go to `inventory_queue`**
  (`infrastructure/messaging/stock-rabbitmq.publisher.ts`). Each is then mirrored onto `ris.events`.
- **Inventory receives its own nine events and discards them.** The inventory `main.ts` sets no
  `noAck`, so the queue auto-acknowledges. No handler matches those routing keys, so Nest logs its
  "no matching event handler" error and the message is gone. This is the same as
  [`retail_queue`](retail-orders.md#what-retail_queue-does-with-an-event). The events survive only as
  their `ris.events` copy.
- **`inventory.stock-level.initialized` means an empty row exists**, not that stock arrived.
  `AutoInitStockLevelUseCase` creates a zeroed level at `INVENTORY_DEFAULT_STOCK_LOCATION` only.

### `catalog.variant.created`

`CatalogEventsConsumer` is the module's only event handler. It passes the event straight to
`AutoInitStockLevelUseCase` (`application/use-cases/auto-init-stock-level.use-case.ts`).

- **A repeat is a no-op.** An existing level returns early. A lost insert race is caught as a
  duplicate entry. Neither publishes an event.
- **Any other error is rethrown out of the `@EventPattern`, and so is a failed publish** after the
  row is saved. `inventory_queue` auto-acknowledges, so neither causes a redelivery. The error is
  logged, and a failed insert leaves no row.
- **A missing level costs nothing.** Every write builds a zeroed level when none exists, and a read
  of a variant with no rows answers zero availability.

## Failure modes

| What breaks                                                          | How it shows                                                                                      | What recovers it                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A negative Adjust or a Transfer leaves on-hand below the commitments | `available` is negative; every new Reserve and direct allocation at that level is `OUT_OF_STOCK`  | A Receive, or releasing holds and allocations                                   |
| A counter drifts from the rows that should explain it                | A plain `Error` and a `500` from the next Release, Allocate, Commit Sale or sweep that touches it | Manual correction: the ledger is an audit trail and cannot rebuild the counters |
| A Release races a sweep, an Allocate or another Release              | `409 RESERVATION_INVALID_STATE`; nothing is released                                              | Nothing needed: the hold was already settled                                    |
| Two Allocate lines on one level the cart holds (direct RMQ only)     | A drift `500`, or other carts' holds silently uncounted                                           | Manual correction of `quantity_reserved`                                        |
| Two Cancel Allocation lines on one level (direct RMQ only)           | Success reported, nothing released                                                                | Resend with the lines merged                                                    |
| Redis is down                                                        | Every availability read goes to MySQL, one `warn` each; invalidations `warn` and are skipped      | Redis returning; an entry missed by invalidation expires on its TTL             |
| A sweep chunk exhausts its retry budget                              | `warn` `Reservation sweep failed`; later chunks of that tick are not tried                        | The next tick                                                                   |
| An event publish fails after the commit                              | A `warn` log; no event and no `ris.events` copy                                                   | Nothing: there is no outbox                                                     |
| Auto-init fails on something other than a duplicate                  | An `error` log; no zeroed level                                                                   | Nothing needed: the first write creates the level                               |
