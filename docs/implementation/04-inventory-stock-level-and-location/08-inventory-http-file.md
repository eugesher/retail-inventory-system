# The `http/inventory.http` walkthrough

This document explains `http/inventory.http` — the Kulala/REST-client file that
exercises every inventory gateway endpoint from an editor. It is the runnable
companion to the two narrative docs that describe the use cases behind these
routes: the [availability read path](07-availability-read-path.md) (the two GETs)
and [Receive Stock and Adjust Stock](06-receive-and-adjust-use-cases.md) (the two
POSTs). Read those for the *why*; read this for *how to drive it by hand*.

Every gateway area has one such file (`http/auth.http`, `http/catalog.http`,
`http/pricing.http`, …). `http/inventory.http` **replaced the deleted
`http/product.http`**: the old file drove `GET /api/product/:productId/stock`
against the superseded `product_stock` model, which no longer exists — the route,
the aggregate, and the file all went away together when the inventory context was
re-founded on per-location `StockLevel` running totals
([ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)).

## The four requests

The file mirrors `apps/api-gateway/src/modules/inventory/presentation/inventory.controller.ts`
one-to-one. Each request carries a `# @name <id>` line (so a later request can
reference an earlier response) and a header comment citing the controller path,
the auth gate, and the body/query shape.

| `# @name` | Method + path | Gate | Purpose |
| --- | --- | --- | --- |
| `login` | `POST /api/auth/staff/login` | `@Public()` | Capture a staff bearer token (prereq) |
| `listLocations` | `GET /api/inventory/locations` | `inventory:read` | List `StockLocationView[]` (optional `?activeOnly`) |
| `getVariantStockAllLocations` | `GET /api/inventory/variants/1/stock` | `@Public()` | `VariantStockView` aggregated across all locations |
| `getVariantStockFiltered` | `GET /api/inventory/variants/1/stock?locationIds=default-warehouse` | `@Public()` | The same read scoped to one location |
| `receiveStock` | `POST /api/inventory/variants/1/stock/receive` | `inventory:adjust` | Raise on-hand by a positive `quantity` |
| `adjustStock` | `POST /api/inventory/variants/1/stock/adjust` | `inventory:adjust` | Apply a signed `quantityDelta` + `reasonCode` |
| `adjustStockBelowZero` | `POST /api/inventory/variants/1/stock/adjust` | `inventory:adjust` | A delta past zero → `409` (the below-zero invariant) |

The two reads and the two writes are the four inventory endpoints; `login` and the
deliberate below-zero adjust are there to make the file self-contained and to prove
the rejection path.

## `# Prereqs:` and the captured `@accessToken`

The header block documents the one-time setup and the seeded login flow:

```text
docker compose up -d
yarn migration:run
yarn test:seed
yarn start:dev
```

The **`login` request must run first**. It posts the seeded admin credentials
(`admin@example.com` / `admin1234`) to `POST /api/auth/staff/login`, and the line

```text
@accessToken = {{login.response.body.$.accessToken}}
```

captures the access token from that response into a file variable. The protected
requests then send `Authorization: Bearer {{accessToken}}`. `admin` holds every
permission code, so it satisfies both `inventory:read` (locations) and
`inventory:adjust` (receive/adjust); the seeded `warehouse@example.com` /
`warehouse1234` (`warehouse-staff`) carries both codes too and is the more
realistic operator for the writes. Permission gating is the gateway's
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)) — a
customer or an under-privileged staff token gets a `403`, and no token at all on a
guarded route gets a `401`.

The two variant-stock GETs intentionally send **no** `Authorization` header — that
is the point of their `@Public()` gate: an unauthenticated shopper can check
availability before deciding to check out. Running them without `login` still
works.

## `?locationIds` encoding and the two omit conventions

Both the read query and the write body can name a stock location, and the
defaulting differs between them — the one subtlety worth internalizing.

**On the read (`?locationIds`)** — a **comma-separated** list of stock-location
ids, e.g. `?locationIds=default-warehouse,backup-store`. A small
`VariantStockQueryDto` splits on commas, trims, drops empties, and also tolerates
the repeated-parameter form (`?locationIds=a&locationIds=b`). The convention:

- **Omit `?locationIds`** → aggregate across *every* location (the `getVariantStockAllLocations`
  request). This is the shopper-facing "is it in stock anywhere?" answer, and it
  is the cache facet `__all__`.
- **Pass a subset** → scope the totals to just those locations (the
  `getVariantStockFiltered` request). Against the seed, scoping variant 1 to
  `default-warehouse` returns the same figures as the all-locations read, because
  that is the only location holding stock for it.

**On the writes (`stockLocationId` in the body)** — omitting `stockLocationId`
targets **`default-warehouse`**, the single location the migration auto-provisions.
So `receiveStock` and `adjustStock` send only the quantity fields and implicitly
hit `default-warehouse`.

The mnemonic: **omit-to-aggregate on the read, omit-targets-`default-warehouse` on
the write.** A read with no scope spans all locations; a write with no scope lands
on the one default location.

## The seeded figures the requests assume

The header notes that the migration provisions `default-warehouse` and the seed
(`scripts/seeds/stock-level.sql`) gives every catalog variant (ids `1..4`) 100 on
hand there. So the requests tell a coherent story against a fresh seed:

1. `getVariantStockAllLocations` → variant 1 reads `totalOnHand: 100`,
   `totalAvailable: 100`, one `default-warehouse` entry.
2. `receiveStock` `{ "quantity": 50 }` → on-hand 100 → **150**.
3. `adjustStock` `{ "quantityDelta": -3, "reasonCode": "damaged" }` → 150 → **147**.
4. `adjustStockBelowZero` `{ "quantityDelta": -100000, … }` → **409 Conflict**, no
   state change (the `STOCK_RESULT_NEGATIVE` domain invariant surfaced through the
   `InventoryRpcExceptionFilter` → the gateway's `throwRpcError`).

Each write returns the updated single-location `StockLevelView`
(`{ stockLocationId, quantityOnHand, quantityAllocated, quantityReserved,
available, version, updatedAt }`); the `reasonCode` on an adjust rides the
`inventory.stock.adjusted` event and the logs — no `StockMovement` audit row is
written yet (deferred to a later capability, see
[06](06-receive-and-adjust-use-cases.md)).

## Self-containment

Like every file under `http/`, this one carries `@baseUrl = {{ENV_BASE_URL}}` at
the top (environment values live in `http/http-client.env.json`), uses `###`
request separators, and references only product/domain concepts — no
orchestration breadcrumbs. The same gateway routes and payloads it documents are
asserted automatically by `test/inventory-availability.e2e-spec.ts` (the reads)
and `test/inventory-receive-and-adjust.e2e-spec.ts` + `test/inventory-cache.e2e-spec.ts`
(the writes + post-commit cache behaviour), so the `.http` file and the e2e suite
stay in lockstep.
