# Address — a polymorphic, snapshot-on-order aggregate

This change adds the **`Address`** aggregate that travels with a placed order: its
domain model, its `address` table, the `IAddressRepositoryPort` +
`AddressTypeormRepository`, and the `AddressView` / `AddressOwnerTypeEnum` wire
contracts. It lands alongside the immutable order in
[03-order-three-status-and-q4-decision.md](03-order-three-status-and-q4-decision.md)
and is recorded in
[ADR-028 §5](../../adr/028-cart-order-payment-and-address-chain.md). It is
**foundation only** — there are no address use cases or gateway routes yet; an
order's addresses are produced by the place capability later.

## One table, two owners — the polymorphic discriminator

An address is not owned by a single kind of thing. A storefront has two distinct
uses for the same shape of data:

- a **reusable address-book entry** a customer saves and re-uses across orders, and
- a **point-in-time snapshot** of where one specific order shipped and billed.

Rather than two near-identical tables, `address` is **polymorphic** over a
`(owner_type, owner_id)` pair:

| Column | Meaning |
| --- | --- |
| `owner_type` | `ENUM('customer','order')` — which kind of thing owns this row |
| `owner_id` | `VARCHAR(36)` — the owner's id: a customer's CHAR(36) UUID, or an order's (short, stringified) numeric id |

A composite **`IDX_ADDRESS_OWNER (owner_type, owner_id)`** index makes "all addresses
for this owner" a single indexed lookup — the read the order view uses to resolve an
order's billing/shipping rows, and the read a future address book uses to list a
customer's saved addresses. `owner_id` is `VARCHAR(36)` precisely so it can hold
*either* discriminated id without a second column.

This capability produces **only `owner_type = order` rows**. The
`owner_type = customer` value ships in the enum and the column shape so the reusable
address-book capability slots in from day one **without a schema change** — but it
has no producer here.

## Why an order's addresses are snapshot copies, not references

At place-time an order's billing and shipping addresses are **snapshotted** — written
as fresh `owner_type = order` rows copied from whatever the buyer supplied at
checkout. An order's address rows are **copies, not references** into a customer
address book.

This is the same immutability guarantee the order lines make about price and
identity, applied to the shipping/billing destination. If an order merely *pointed*
at a row in the customer's address book, a later edit to that book entry — the
customer fixing a typo, moving house, or deleting the address — would silently
rewrite where a historical order was recorded as shipping. A captured order is a
contract about what happened; the address it shipped to is part of that record and
must be frozen at the instant of purchase. Copying the data into an
`owner_type = order` row decouples the order from the (future, mutable) address book
entirely: the two never share a row.

`Order` holds its addresses as plain `billing_address_id` / `shipping_address_id`
`CHAR(36)` pointers (with FKs to `address(id)`) — they are pointers to the
snapshotted rows, not an owned `@ManyToOne` relation, so a plain column + FK is
enough.

## The `Address` model

`Address extends AggregateRoot<string | null>` and is framework-free (no `@nestjs/*`,
no `typeorm` — [ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md)).

- **Identity** — a `CHAR(36)` UUID generated in-app by `Address.forOrder(...)` (the
  caller-assigned path, like the cart id), so the id is concrete from the moment the
  address exists and can be written onto the order before any DB round-trip. On the
  load path `reconstitute` carries the stored id.
- **`forOrder({ orderId, recipientName, … })`** — the place-time snapshot factory:
  sets `ownerType = order`, `ownerId = orderId`, generates the UUID, and validates.
  (There is no `customer` factory — that owner type is reserved for the address-book
  capability.)
- **Invariants, all enforced at construction (the unit spec asserts each):**
  - `recipientName`, `line1`, `city`, `region`, `postalCode` are **non-empty**.
  - `country` is a **2-letter ISO code, upper-cased** — the model normalises
    (`us → US`) then validates `^[A-Z]{2}$`, so `USA` (too long) and `u` (too short)
    are rejected.
  - `ownerType` is one of the two `AddressOwnerTypeEnum` values.
  - `line2` and `phone` are optional (nullable).

> **An ordering note for the place capability.** An order's address rows want
> `ownerId = <order id>`, but the order's id is assigned by persistence while the
> order needs the address ids to store as its billing/shipping pointers. The place
> use case resolves this small chicken-and-egg (e.g. persist the order to obtain its
> id, then write the snapshot rows with that id, then point the order at them) when
> it lands; this foundation only fixes the model and the repository. The `address.id`
> is known in-app immediately, so only `ownerId` needs the order id.

## Persistence shape

`AddressEntity` overrides `BaseEntity`'s integer PK with a `CHAR(36)` string PK (the
same `Omit<BaseEntity, 'id'>` technique `CartEntity` / `StockLocationEntity` use),
inheriting `createdAt` / `updatedAt` / `deletedAt`. `deletedAt` stays **inert** — an
address is immutable, never soft-deleted. `AddressTypeormRepository` is a single
`@InjectRepository` site doing a one-row upsert by the caller-assigned UUID (no owned
children, so no transaction), then re-reading for the committed timestamps. It
returns domain types only — no TypeORM leak past it
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)).

`AddressView` is the RPC/HTTP response shape (a class carrying `@ApiResponseProperty`,
the documented lib-contracts Swagger exception). `findByOwner(ownerType, ownerId)`
on the port is the read backed by the composite index — it is how the order view
resolves an order's snapshotted billing/shipping rows once the read capability lands.
