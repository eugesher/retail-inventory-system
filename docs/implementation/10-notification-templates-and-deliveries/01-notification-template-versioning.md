# Notification template versioning — the `NotificationTemplate` registry

This document introduces the **`NotificationTemplate`** aggregate — the versioned,
per-`(eventType, channel, locale)` registry that backs every rendered notification. It
covers the data + domain foundation: the model, its table, the repository port, the
wire view/enum, and where it sits in the migration. The author / activate / rollback
**operations** that mutate the registry are described in a sibling operations document;
this foundation establishes the shape they build on.

Until now the notification microservice assembled every notification's subject and body
from **string literals in TypeScript**. Changing the wording of an email meant editing
and redeploying code, with no per-locale variation and no audit of who changed what.
This registry makes notification copy **data, not code**.

## 1. What a template is

A `NotificationTemplate` is one entry in a registry keyed on the natural triple
**`(eventType, channel, locale)`**:

- `eventType` — the business event that triggers the notification (e.g.
  `retail.order.placed`).
- `channel` — the *business* channel the customer is reached over
  (`email` / `sms` / `push` / `webhook`, the wire `NotificationChannelEnum`). This is
  distinct from the `NOTIFIER` *transport* adapter (log / email / webhook); the channel
  is "how the customer is reached", the transport is "how this service sends it".
- `locale` — the BCP-47 tag the copy is written in (e.g. `en-US`).

Each template carries a `subject` (nullable), a `body` (the Handlebars source), a
`version`, and an `active` flag. The `subject` rule is **channel-specific**: it is
required for `email` / `webhook` (an email without a subject line is malformed) and
optional for `sms` / `push` (an SMS has no subject). The aggregate enforces this in
`create`, and `withNextVersion` re-runs it, so an edit cannot silently drop a required
subject.

The aggregate records **no domain events** — a template edit is an internal registry
change, not a cross-service fact (the `Category` / `MediaAsset` precedent in
[ADR-029](../../adr/029-category-materialized-path-and-polymorphic-media.md)).

## 2. Why `version` is part of the natural key

The unique key is **`(event_type, channel, locale, version)`** — `version` is part of
the key, so **every version is a distinct retained row**. This is what makes an edit
*append* rather than *overwrite*:

- Editing the order-confirmation email does not rewrite the live row. The domain's
  `withNextVersion({ subject, body })` derives a **brand-new** template for the same
  `(eventType, channel, locale)` at `version + 1`, `active`, with a null id (a fresh row
  to be inserted). The prior version's row is left untouched.
- The full edit history is therefore retained for **audit** ("what did the email say
  last month?") and **rollback** ("re-activate version 3"). Nothing is ever destroyed by
  an edit.
- The **live entry** for a key is the **highest-`version` `active` row** — what the
  render pipeline resolves on every outgoing notification.

`version` is the **business version, not an OCC token.** It is a plain `INT` the registry
owns and that participates in the natural key — it answers "which edit is this?". This is
deliberately distinct from `order.version` / `fulfillment.version`, which are
TypeORM-managed `@VersionColumn` optimistic-lock tokens that advance on every persist
regardless of business meaning. The notification tables ship **no** OCC column:
last-writer-wins is acceptable for a staff-authored registry (the catalog stance,
[ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)). Conflating the two
meanings on one column was rejected.

The repository derives the next version from
`maxVersion(eventType, channel, locale)` — the highest `version` across **all** rows for
the key (active or not), so a rollback that deactivated the newest version still advances
past it on the next edit rather than colliding.

## 3. Soft-delete via `active`, not `deletedAt`

A template is retired by flipping its `active` flag to `false` (`deactivate()`), not by
writing a `deletedAt` timestamp. The row stays — it is simply excluded from the "find
latest active" resolution. `activate()` is the inverse, and both are **idempotent** (a
second call is a no-op).

This matches the `StockLocation` / `Category` convention: lifecycle state lives in a
business flag, and the inherited `BaseEntity.deletedAt` column stays **inert** (never
written). Keeping retired rows is exactly what enables rollback — a "deleted" template
would be unrecoverable; a deactivated one is one `activate()` away.

## 4. The "find latest active" index

The render pipeline's hot-path query is "give me the live template for this
`(eventType, channel, locale)`" — i.e. the highest-`version` row where `active = 1`. The
table carries a dedicated index **`(event_type, channel, locale, active)`** to serve it:
the three key columns scope the scan, and `active` lets the engine skip deactivated rows
without a table touch. The repository's `findLatestActive(...)` issues
`WHERE event_type = ? AND channel = ? AND locale = ? AND active = 1 ORDER BY version DESC
LIMIT 1`.

## 5. The table

`notification_template` (one migration, `synchronize` off —
[ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)):

| column | type | notes |
|---|---|---|
| `id` | BIGINT UNSIGNED PK | `BaseEntity` (the `@PrimaryGeneratedColumn()` int widened to BIGINT in the migration) |
| `event_type` | VARCHAR(64) | the trigger key |
| `channel` | ENUM(`email`,`sms`,`push`,`webhook`) | the business channel |
| `locale` | VARCHAR(10) | BCP-47 tag |
| `subject` | TEXT NULL | nullable for sms/push |
| `body` | TEXT | Handlebars source |
| `version` | INT | the business version (not OCC) |
| `active` | TINYINT(1) DEFAULT 1 | soft-delete flag |
| `created_at`/`updated_at` | timestamps | `BaseEntity` |
| `deleted_at` | TIMESTAMP NULL | **inert** |

Constraints/indexes: `UNIQUE (event_type, channel, locale, version)` (every version a
distinct row) and `INDEX (event_type, channel, locale, active)` (the find-latest-active
scan).

## 6. The repository port and the wire view

`INotificationTemplateRepositoryPort` (`NOTIFICATION_TEMPLATE_REPOSITORY`) returns domain
types only — no TypeORM leak (the
[ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md) boundary):
`save`, `findById`, `findLatestActive`, `findByNaturalKey`, `maxVersion`, and a filtered
`list`. `NotificationTemplateTypeormRepository` is the single
`@InjectRepository(NotificationTemplateEntity)` site; `save` re-reads by id so the
returned aggregate carries the generated BIGINT id and committed timestamps (the "re-read
the saved graph" idiom).

`NotificationTemplateView` (in `libs/contracts/notifications`) is the RPC/HTTP response
shape — `id`, `eventType`, `channel`, `locale`, `subject` (nullable), `body`, `version`,
`active`, `createdAt`, `updatedAt`.

The `notificationsTemplate(eventType, channel, locale)` cache-key builder (`v1`) is added
to `CACHE_KEYS` **unconsumed** (the notification service does not yet import
`CacheModule`) — the registry resolution is the natural future caching candidate, and the
builder lets a future cached read path adopt the `ris:notifications:template:v1:…` key
shape without re-keying ([ADR-016](../../adr/016-cache-aside-generalized.md) /
[ADR-022](../../adr/022-cache-keys-tenant-and-schema-version.md)).

See the [sibling delivery document](02-notification-delivery-as-audit-trail.md) for the
delivery audit trail, and
[ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md) for the
whole capability's rationale.
