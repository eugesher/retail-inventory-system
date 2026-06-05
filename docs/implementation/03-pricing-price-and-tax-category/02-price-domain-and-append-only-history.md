# 02 — The `Price` domain and the append-only history

This document records the pricing module's write/read **state**: the `Price`
domain model and the append-only-for-history ledger it sits in, the
`(variantId, currency)` scope, the at-most-one-open invariant and its DB-level
backstop, and the repository seam over all of it. The `TaxCategory` label and the
variant attachment are covered in the sibling
[03 — `TaxCategory` and variant attachment](03-tax-category-and-variant-attachment.md);
the scaffold this builds on is
[01 — The pricing module scaffold](01-pricing-module-scaffold.md).

The code lives under `apps/catalog-microservice/src/modules/pricing/`. The
decision behind it is
[ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md); it honors
[ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md) (the domain
is framework-free), [ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)
(the import boundaries), [ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)
(`BaseEntity`, `SnakeNamingStrategy`, hand-authored migrations), and
[ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md) (the
`variantId` backbone and the `DomainException` + typed-code pattern).

## 1. Append-only-for-history: why a `Price` is never edited in place

The requirement that frames the whole design is **auditability of every price
change**. You must be able to answer not only "what does this variant cost now?"
but "what did it cost on the 3rd, and when did that change?" An in-place mutable
price — one row per variant/currency, overwritten on each change — cannot answer
that. An `updated_at` tells you *that* a row changed, never *from what to what*
or *over which window*.

So a `Price` is **one row in an append-only ledger**, and a price *change* is
modelled as two operations rather than an edit:

1. **Append** a new row carrying the new amount, open (`validTo = null`).
2. **Close** the predecessor by setting its `validTo` to the changeover instant.

The old row is retained, closed, forever. Nothing is overwritten, so the history
is not reconstructed — it simply *is* the set of rows. Reading "what did this
cost on date *D*" is "which row's `[validFrom, validTo)` interval contains *D*."

### The `[validFrom, validTo)` interval ledger

Each row owns a **half-open** interval `[validFrom, validTo)`: inclusive of the
start, exclusive of the end. Half-open is what makes adjacent intervals tile
without overlap or gap — the predecessor's `validTo` equals the successor's
`validFrom`, and an instant exactly at the boundary belongs to the successor.
A row with `validTo = null` is **open**: in effect now with no scheduled end.

```
amount  ──1999──────┐
                    │ close at T1 (predecessor.validTo = T1)
        ──2500──────┴────────────┐
                                 │ close at T2
        ──2200───────────────────┴──────►  (open: validTo = null)
        validFrom=T0     T1      T2        now
```

Three rows, three intervals, full history: `[T0,T1) = 1999`, `[T1,T2) = 2500`,
`[T2, ∞) = 2200`. The "every Price change is auditable" rule is satisfied by
construction — each change *is* a row.

### The model enforces append-only by construction

`Price` (`domain/price.model.ts`) is a framework-free class (it extends the
`Entity` base from `libs/ddd` for id-identity; no `@nestjs/*`, no `typeorm`, no
`class-validator`). Two things make the append-only rule structural rather than a
convention a caller must remember:

- **Two construction paths with different guards.**
  - `Price.set({ variantId, currency, amountMinor, validFrom?, validTo?,
    priority? })` is the standard write path. `validFrom` **defaults to "now"**,
    and a `validFrom` **strictly before now** is rejected with
    `PRICE_VALID_FROM_IN_PAST`. You set or schedule only open intervals at or
    after now; you can *never* author a historical row through this path. (`now`
    is an injectable second argument so specs are deterministic.)
  - `Price.reconstitute({ id, variantId, currency, amountMinor, validFrom,
    validTo, priority })` loads a persisted row with **any** `validFrom`,
    including the past — no guard. The repository uses it for every row it
    materializes, including a closed predecessor.
- **`close(at)` is the only mutation an existing row ever receives.** It returns
  a **new** `Price` with the same value fields and `validTo = at`. There is **no
  setter** for `amountMinor`, `currency`, `variantId`, or `priority` — they are
  `readonly` and set once in the constructor. Closing at a time at-or-before
  `validFrom` raises `PRICE_INTERVAL_INVALID` (an empty interval). Because the
  value fields are immutable and the only mutation is a close, a price value
  change is *forced* to be "new row + close predecessor" — the model gives a
  caller no other move.

The invariants, each raising a `PricingDomainException` with a typed
`PricingErrorCodeEnum` code (the ADR-025 pattern):

| Rule | Code |
| --- | --- |
| `amountMinor` is an integer `≥ 0` | `PRICE_AMOUNT_INVALID` |
| `currency` matches `^[A-Z]{3}$` (ISO-4217 *shape* only) | `PRICE_CURRENCY_INVALID` |
| when `validTo` is set, `validFrom < validTo` | `PRICE_INTERVAL_INVALID` |
| `validFrom` not strictly before now (on `set`) | `PRICE_VALID_FROM_IN_PAST` |
| `priority` is an integer (default `0`) | `PRICE_PRIORITY_INVALID` |

`amountMinor` is **minor units** (an integer count of cents), never a float —
money is integer arithmetic. `currency` is validated for *shape* only; pricing
does no currency registry lookup or rate conversion.

## 2. The `(variantId, currency)` scope

A `Price` is scoped by exactly two axes: which variant, and which currency. That
is the **entire** scope surface this capability has. The at-most-one-open
invariant, the open-scope key, and the resolve query are all defined over the
`(variantId, currency)` pair.

Location-, channel-, and customer-group pricing are deliberately **out of
scope**. They are real features of a mature pricing engine, but the system has no
multi-location, multi-channel, or customer-tier concept to scope a price
*against* yet — adding the columns now would be speculative machinery filling a
dimension nobody can populate. When a concrete need appears, a future
`priceScope` extension lifts the axis; until then `(variantId, currency)` is the
whole story. `variantId` is the downstream backbone key catalog established
(ADR-025): inventory stock, pricing, and order lines all address the *variant*.

## 3. At-most-one-open: app primary, DB backstop

The scope invariant is: **at most one open (`validTo IS NULL`) row per
`(variantId, currency)`.** Two open rows would make "the current price" ambiguous
— a state the resolution step must never see. It is enforced in two layers, and
both matter.

### Primary mechanism — close-in-transaction

`IPricingRepositoryPort.appendPrice(newPrice, predecessorToClose)`
(`application/ports/pricing.repository.port.ts`) is the atomic append. Its
adapter, `PricingTypeormRepository.appendPrice`, runs **one** TypeORM
transaction (`priceRepository.manager.transaction(...)`):

1. If `predecessorToClose` is non-null, `UPDATE` its `valid_to` (the caller
   passes the already-closed predecessor — `open.close(at)` — so its `validTo`
   is the concrete changeover instant).
2. `INSERT` the new open row.

then re-reads the inserted row so its DB-assigned id comes back concrete — the
same "re-read the saved graph" idiom `CatalogTypeormRepository.save` uses. Both
statements commit together, so there is never a committed window with two open
rows for one scope. The *resolution* of which predecessor to close (and the
Select Applicable policy) lives in the price use case that builds on this port;
the repository just executes the close+insert atomically.

### Backstop — a generated-column UNIQUE index

The app transaction keeps the common path clean, but a racing double-append
(two requests for the same scope at once) could still try to insert two open
rows. The backstop is a database-level guarantee.

MySQL has **no native partial unique index** — you cannot write Postgres's
`UNIQUE (variant_id, currency) WHERE valid_to IS NULL`. It is emulated with a
`STORED` generated column that is non-NULL **only while the row is open**:

```sql
open_scope_key VARCHAR(32) GENERATED ALWAYS AS
  (CASE WHEN valid_to IS NULL THEN CONCAT(variant_id, ':', currency) ELSE NULL END) STORED,
CONSTRAINT UC_PRICE_OPEN_SCOPE UNIQUE (open_scope_key)
```

The trick rests on a MySQL rule: **a UNIQUE index permits many NULLs.** So:

- A **closed** row has `valid_to` set → `open_scope_key` is NULL → it never
  collides. Any number of closed rows for one scope coexist (the history).
- An **open** row has `valid_to IS NULL` → `open_scope_key` is `"<variant>:<ccy>"`
  → two open rows for one scope produce the same key, and the second insert fails
  with a duplicate-key error.

This was verified live: a second open `7:USD` row fails on `UC_PRICE_OPEN_SCOPE`,
while a closed `7:USD` row plus a new open `7:USD` row plus an open `7:EUR` row
all coexist. The column is **not mapped** on `PriceEntity` — it is a DB-internal
backstop; with `synchronize` off TypeORM never touches it, and an insert that
omits it lets MySQL compute it. A concurrency test exercises this backstop in the
gateway-level work.

## 4. `variantId` as an opaque link — the FK is the only coupling

The pricing domain **never imports the catalog `Product` or `ProductVariant`.** A
`Price` holds `variantId: number` and nothing else about the variant. The only
place the two contexts touch is the foreign key in persistence:

```sql
CONSTRAINT FK_PRICE_VARIANT FOREIGN KEY (variant_id)
  REFERENCES product_variant (id) ON DELETE RESTRICT
```

`ON DELETE RESTRICT` means a variant with prices cannot be hard-deleted — which
is consistent with catalog's own stance that variants are soft-deleted via
`status` and stay resolvable forever (ADR-025). The boundaries lint
(ADR-017) enforces the no-import rule: pricing's `domain/` may import only
`libs/{ddd,common,contracts}`, and a `pricing → catalog/domain` edge is a
cross-module violation. This is the same isolation a service boundary would give,
held by lint between two modules in one process.

## 5. Persistence shapes and the BIGINT coercion

`PriceEntity` (`infrastructure/persistence/price.entity.ts`) extends `BaseEntity`
(ADR-019): the migration widens the `@PrimaryGeneratedColumn()` `id` to BIGINT
UNSIGNED (`synchronize` is off, so the migration is the source of truth), and the
inherited `createdAt`/`updatedAt`/`deletedAt` come along — `deletedAt` stays
**inert**, exactly as the catalog tables leave it, because pricing is append-only
and never soft-deletes. `SnakeNamingStrategy` maps `variantId → variant_id`,
`amountMinor → amount_minor`, `validFrom → valid_from`, `validTo → valid_to`, so
no `@Column({ name })` overrides are needed. `variantId` is a plain BIGINT scalar
with **no `@ManyToOne` relation** — a relation would require importing the
catalog entity, the very cross-module import that is forbidden.

One driver detail the mappers handle: the **mysql2 driver returns non-PK BIGINT
columns as strings** (the same reason the inventory stock repository coerces with
`Number(item.quantity)`). So `PriceMapper.toDomain` coerces `variant_id` and
`amount_minor` back to numbers with `Number(...)` before handing them to
`Price.reconstitute`. The BIGINT **primary key** comes back as a number via
`@PrimaryGeneratedColumn()`, so `id` needs no coercion. A unit test asserts the
coercion (passing string-typed fields through `toDomain` and checking the result
is a `number`).

## 6. The repository port — domain types only

`IPricingRepositoryPort` (`+ PRICING_REPOSITORY` symbol) returns **domain types
only** — no TypeORM `Repository`/`EntityManager`/entity leaks (ADR-017 forbids
`typeorm` in `application/ports`). Its price methods:

| Method | Purpose |
| --- | --- |
| `findOpenPrice(variantId, currency)` | The single open row for a scope, or null (the predecessor the write use case closes). |
| `appendPrice(newPrice, predecessorToClose)` | Atomic close-of-predecessor + insert, re-read with concrete id (§3). |
| `findInEffect(variantId, currency, asOf)` | All rows whose `[validFrom, validTo)` contains `asOf` — a **coarse** candidate set; the priority/recency pick lives in the use case (ADR-026 §4). |

`findInEffect` is backed by `IDX_PRICE_RESOLVE (variant_id, currency, valid_from
DESC)` and orders by `priority DESC, validFrom DESC` as a convenience — but the
authoritative Select Applicable policy (highest priority, then latest
`validFrom`) is the use case's, not the query's, so the rule stays unit-testable
and free to evolve without a schema change. `PricingTypeormRepository` is the
single `@InjectRepository` site for the context; it is bound to
`PRICING_REPOSITORY` via `useExisting` in `pricing.module.ts`, which also
registers `DatabaseModule.forFeature([PriceEntity, TaxCategoryEntity])`. The
module-root `index.ts` now exports `pricingEntities = [PriceEntity,
TaxCategoryEntity]`, which the service composition root spreads into its single
`DatabaseModule.forRoot([...catalogEntities, ...pricingEntities])` — so both
colocated modules share one MySQL connection with no `app.module.ts` change.

## What this does not do

This is the domain + persistence half. There is **no** price-write or
price-resolution use case yet (set/schedule a price, Select Applicable), **no**
pricing events or routing keys, **no** `@MessagePattern` controller, **no**
gateway routes or `.http` file, and **no** real active-Price publish hard-fail —
each lands in its own document as the pricing context grows. The tax-category
label and the variant attachment are in
[03 — `TaxCategory` and variant attachment](03-tax-category-and-variant-attachment.md).
