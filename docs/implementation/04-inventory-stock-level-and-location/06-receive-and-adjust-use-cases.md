# Receive Stock and Adjust Stock — the first write operations

This document describes the two Stage-1 write operations on the inventory running-
totals model: **Receive Stock** (`quantityOnHand += n`) and **Adjust Stock** (a
signed delta with a mandatory `reasonCode`). Both raise or lower a variant's
on-hand quantity at one [`StockLocation`](02-default-stocklocation-auto-provision.md),
update the [`StockLevel`](03-stocklevel-aggregate-and-version-column.md) row, and
are exposed over HTTP through the API gateway. It covers the use-case contracts
and invariants, the post-commit cache-invalidation flow, lazy-init of a missing
row, the events the operations emit (including the preserved low-stock alert), the
below-zero → `409` mapping, and the staff-only `inventory:adjust` gate.

The read side these writes feed is the
[availability read path](07-availability-read-path.md); the zeroed row a write
lands on is usually the one [auto-init](05-auto-init-on-variant-created.md)
created when the variant was first published.

## Why two operations, and why now

The running-totals model
([ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)) keeps
`quantityOnHand` / `quantityAllocated` / `quantityReserved` as maintained
counters, with `available = onHand − allocated − reserved` a pure getter. Stage 1
needs only the two operations that move **on-hand**:

- **Receive** models goods arriving — a purchase-order receipt, a return to
  stock, an initial load. It only ever raises on-hand, so it can never breach the
  non-negativity invariant and never triggers a low-stock alert.
- **Adjust** models a correction — a cycle-count delta, shrinkage, damage. It is
  signed, carries a mandatory audit `reasonCode`, and a downward adjustment that
  would drive on-hand below zero is rejected.

Allocation, reservation, commit-sale, cancel, restock-from-return, and transfer
are **out of scope** here — they belong to the later inventory-reservation
capability, together with the `version` optimistic-lock enforcement and the
`StockMovement` audit ledger. Crucially, **no `StockMovement` row is written by
either operation today**: the `reasonCode` is carried in the request, in the
`inventory.stock.adjusted` event, and in the logs — that is the entire audit trail
until the movement ledger lands.

## The use cases

Both use cases live in the inventory microservice's `stock` context
(`application/use-cases/`) and are transport- and ORM-free
([ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md) /
[ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)). They depend
only on injected ports: the repository, the cache, the events publisher, and the
transaction port.

### `ReceiveStockUseCase`

Input `{ variantId, stockLocationId?, quantity, actorId?, correlationId? }`.
`stockLocationId` defaults to `default-warehouse`
(`INVENTORY_DEFAULT_STOCK_LOCATION`).

1. **Validate** `quantity` is a positive integer (else reject with a typed
   `STOCK_RECEIVE_QUANTITY_INVALID` → `400`). This is a backstop — the gateway DTO
   rejects it first.
2. **Require an active location** — `repo.findLocation` must return a row
   (`STOCK_LOCATION_NOT_FOUND` → `404`) that is `active` (`STOCK_LOCATION_INACTIVE`
   → `409`).
3. **Write** (inside the post-commit invalidation wrapper, below): find-or-
   `initialAt` the `StockLevel`, `changeOnHand(+quantity)`, `saveStockLevel`.
4. **Emit** `inventory.stock.received` post-commit (best-effort).
5. **Return** the updated `StockLevelView` for the affected location.

### `AdjustStockUseCase`

Input `{ variantId, stockLocationId?, quantityDelta, reasonCode, actorId?,
correlationId? }`.

1. **Validate** `quantityDelta` is a non-zero integer
   (`STOCK_ADJUSTMENT_DELTA_INVALID` → `400`) and `reasonCode` is a non-empty
   string (`STOCK_ADJUSTMENT_REASON_REQUIRED` → `400`).
2. **Require an active location** (same as receive).
3. **Write**: find-or-`initialAt`, `changeOnHand(delta)` — which **rejects a
   result below zero** with `STOCK_RESULT_NEGATIVE` (→ `409`) **before** any save —
   `saveStockLevel`.
4. **Emit** `inventory.stock.adjusted` post-commit; then, if the post-commit
   on-hand is **at or below** `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`, emit
   `inventory.stock.low`.
5. **Return** the updated `StockLevelView`.

### Lazy-init of a missing `StockLevel`

Both use cases find-or-`initialAt`: if no `stock_level` row exists for
`(variantId, stockLocationId)`, they start from `StockLevel.initialAt(...)`
(a zeroed level) and apply the delta on top. Auto-init normally creates this row
when the variant is published, but a write must not depend on the async consumer
having run — a Receive against a never-seen variant simply creates the row at the
received quantity. (The `(variant_id, stock_location_id)` UNIQUE constraint plus
the repository's resolve-to-existing-id-before-save keep this an upsert, not a
duplicate-row hazard.)

## Post-commit cache invalidation (`withInvalidation`)

The cached availability is a per-variant `VariantStockView` under the `v2` key
shape ([ADR-022](../../adr/022-cache-keys-tenant-and-schema-version.md) /
[ADR-016](../../adr/016-cache-aside-generalized.md)). A write must invalidate it
**after** the commit, never before — invalidating before commit would let a
concurrent read re-cache the pre-write value while the row is still being written
([ADR-002](../../adr/002-redis-cache-aside-product-stock.md)).

[ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md) makes this
ordering a type-level guarantee: `IStockCachePort` has **no public
`invalidate(...)`**. The only way to invalidate on a write is

```text
stockCache.withInvalidation(work, resolveItems, { correlationId })
```

where `work` is the transactional read-modify-write and `resolveItems(result)`
derives the `{ variantId, stockLocationId }[]` to wipe from the saved level. The
helper awaits `work()` (so the commit is durable) and only then fires the private
prefix delete. The receive/adjust use cases wrap their write exactly this way:

```text
work    = transactionPort.runInTransaction(() => {
            find-or-initialAt → changeOnHand → saveStockLevel
          })
resolve = (saved) => [{ variantId: saved.variantId, stockLocationId: saved.stockLocationId }]
```

The transaction goes through `ITransactionPort` (`TRANSACTION_PORT`), keeping the
use case ORM-free — the `EntityManager` downcast lives only in the TypeORM
adapter. On a rejection inside `work` (e.g. the below-zero guard fires), the helper
performs **no** cache mutation: no commit, no invalidate, no event. The end-to-end
proof is `test/inventory-cache.e2e-spec.ts` — it primes the cache, receives stock,
and asserts the next read reflects the post-commit figure rather than the stale
primed one.

> The cache fan-out wipes four prefixes per `variantId` (the current `v2` plus
> three legacy families) during the transition window — see
> [the cache-key bump](04-cache-key-bump-v1-to-v2.md). On a Redis outage the
> invalidation is warn-logged and swallowed; correctness is preserved and the TTL
> is the safety net.

## Events

All three events are framework-free wire interfaces in
`libs/contracts/inventory/events/` — a `DomainEvent` subclass is never serialized
across services ([ADR-011](../../adr/011-notifier-port-and-adapters.md)); the
publisher maps the in-process domain event to the wire shape.

| Event | Routing key | Destination queue | Consumer |
| --- | --- | --- | --- |
| `inventory.stock.received` | `inventory.stock.received` | `inventory_queue` | none yet (reserved) |
| `inventory.stock.adjusted` | `inventory.stock.adjusted` | `inventory_queue` | none yet (reserved) |
| `inventory.stock.low` | `inventory.stock.low` | `notification_events` | notification service |

The destination queue is fixed by **which client the publisher emits through**
([ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md) /
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md), the producer-targets-
consumer-queue pattern): the received/adjusted events go through the
`INVENTORY_MICROSERVICE` client onto the service's own `inventory_queue` (reserved
surfaces with no consumer bound yet — a later audit/projection capability), while
the low-stock alert goes through the `NOTIFICATION_MICROSERVICE` client onto
`notification_events`. All post-commit emits are **best-effort**: a publish
failure is warn-logged, not raised — the write already committed, so failing the
RPC would wrongly tell the caller the write did not happen.

### The preserved low-stock alert, re-sourced

The `inventory.stock.low` event predates the rewrite; its purpose and threshold
semantics are unchanged. What changed is its **source and shape**. It is now
re-sourced from `StockLevel.quantityOnHand` after an Adjust commits, and its
payload is re-keyed onto the new model:

```text
{ variantId, stockLocationId, quantity, threshold, eventVersion: 'v1',
  occurredAt, correlationId }
```

(previously `{ productId, storageId, quantity, threshold, occurredAt,
correlationId }`). The notification service's `InventoryEventsConsumer` →
`SendLowStockAlertUseCase` was updated to read the new field names; the alert
message text and behaviour are unchanged. The threshold is the cross-service
constant `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`, never an env var or DB column
([ADR-012](../../adr/012-stock-aggregate-and-port-adapter.md) §low-stock, carried
forward). Receive never lowers on-hand, so it never evaluates the low-stock
boundary.

## Gateway endpoints and the `inventory:adjust` gate

The gateway `inventory` module fronts the two writes over HTTP:

| Route | Permission | Body |
| --- | --- | --- |
| `POST /api/inventory/variants/:variantId/stock/receive` | `inventory:adjust` | `{ stockLocationId?, quantity }` |
| `POST /api/inventory/variants/:variantId/stock/adjust` | `inventory:adjust` | `{ stockLocationId?, quantityDelta, reasonCode }` |

Both are gated with `@RequiresPermission(PermissionCodeEnum.INVENTORY_ADJUST)`
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)). Because
customer tokens carry no `permissions` claim, the writes are **staff-only by
construction** — a customer or an unprivileged staff token (e.g. a
catalog-manager) gets a `403`. The controller threads the current staff user's id
as `actorId` via `@CurrentUser()`. Request DTOs validate at the edge
(`quantity` positive int; `quantityDelta` non-zero int; `reasonCode` non-empty;
`stockLocationId` optional) so a malformed request fails fast with a `400` before
any RPC dispatches.

### Below-zero → `409`

The domain `StockLevel.changeOnHand` throws a typed `InventoryDomainException`
(code `STOCK_RESULT_NEGATIVE`) when a delta would drive on-hand below zero — the
inventory context's first concrete `DomainException` (after the catalog and
pricing ones). A presentation-layer `InventoryRpcExceptionFilter` maps each code
onto an HTTP status and terminates the exception into the `{ statusCode, message,
code }` wire shape the gateway's `throwRpcError` understands. Below-zero and an
inactive location map to `409`; a missing location to `404`; the malformed-input
codes to `400`. This mirrors the catalog
([ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)) and pricing
([ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md)) filters
exactly. The e2e asserts the `409` on `Adjust -100`.

## What is deferred

- **`StockMovement` persistence** — no movement/audit row is written; `reasonCode`
  lives only in the event + logs until the audit-log capability lands.
- **Reservation / allocation / commit-sale / cancel / restock / transfer** and the
  no-oversell **`version`** enforcement — the later inventory-reservation
  capability. `StockLevel` deliberately exposes only `changeOnHand` today.
