# The auto-provisioned default `StockLocation`

Inventory is location-aware from the first row: every `stock_level` references a
`stock_location`, and the schema guarantees at least one location always exists.
Exactly one default location, `default-warehouse`, is provisioned by the
migration itself.

## The decision: exactly one default, always present

A location-aware inventory model has a bootstrapping question: what location do
the first stock levels belong to before an operator has created any warehouse?
Two answers were possible — make the location optional (allow zero locations and
special-case "unassigned"), or guarantee one default location always exists. We
chose the latter, the Vendure-style stance: there is always a default location,
and a single-warehouse deployment never has to think about locations at all.

The default is seeded with a stable, human-readable identity so downstream code
can refer to it by a known constant
(`INVENTORY_DEFAULT_STOCK_LOCATION = 'default-warehouse'` in the contracts
library):

| Column   | Value               |
| -------- | ------------------- |
| `id`     | `default-warehouse` |
| `name`   | `Default Warehouse` |
| `code`   | `default-warehouse` |
| `type`   | `warehouse`         |
| `active` | `true`              |

## Idempotent provisioning in the migration

The location is inserted by the migration, not by a runtime seed, so the schema
and its one guaranteed row arrive together. The insert is idempotent:

```sql
INSERT INTO stock_location (id, name, code, type, active)
VALUES ('default-warehouse', 'Default Warehouse', 'default-warehouse', 'warehouse', TRUE)
ON DUPLICATE KEY UPDATE id = id;
```

`ON DUPLICATE KEY UPDATE id = id` makes a re-run a no-op rather than an error:
the primary key (`id`) and the `UNIQUE (code)` constraint both match the
existing row, so a second application changes nothing. This matters because the
migration's `down` recreates the prior schema and a subsequent `up` must
re-provision without failing — the migration applies, reverts, and re-applies
cleanly.

## Why making the default optional is a migration hazard

If locations were optional, the very first `stock_level` row would have no valid
`stock_location_id` to reference, forcing either a nullable FK (and an
"unassigned stock" special case threading through every read) or a
chicken-and-egg ordering where the application must create a location before it
can record any stock. The moment a **second** warehouse is added, code written
against the "maybe there's no location" assumption has to be revisited. Anchoring
on one always-present default removes that class of bug: the FK is non-nullable,
every stock level has a real location, and multi-location simply means "more than
one row in `stock_location`".

## Adding more locations later

A second (or third) location is just another `stock_location` row — created
through the location-management surface a later capability exposes, with its own
`type` (`store`, `dropship-virtual`, …), `code`, and optional `address`/`gln`.
Stock levels for a variant at different locations are distinct `stock_level` rows
under the `UNIQUE (variant_id, stock_location_id)` constraint. What stays **out
of scope** here is multi-location *order routing* — deciding which location
fulfils a given order line. This foundation makes the data multi-location-ready;
the routing policy is a separate, later concern.

See [01-old-tables-dropped-and-new-schema.md](01-old-tables-dropped-and-new-schema.md)
for the full schema and
[ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md) for the
decision record (including the rejected alternatives: an optional default and a
`deletedAt`-based soft-delete for locations).
