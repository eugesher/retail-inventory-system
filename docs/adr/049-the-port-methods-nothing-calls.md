# ADR-049: The port methods nothing calls — and why a port is where that is expensive

- **Date**: 2026-07-12
- **Status**: Accepted

---

## Context

[ADR-048](048-two-scaffold-adapters-that-were-never-wired.md) ended the *file*-level sweep of `apps/` — dead exports, dead files, dead providers. This is the level below: dead **logic inside live classes**. Three questions, and only one of them found anything.

| Question | Declared | With no caller |
| --- | --- | --- |
| Methods on `application/ports/` interfaces | 254 across 60 ports | **8** |
| `*ErrorCodeEnum` members ever thrown | 149 | **0** |
| Public members on domain aggregates | — | **0** (see §4) |

149 error codes, every one of them thrown by some use case, is a genuinely good result — the error taxonomy is not aspirational. The eight port methods are the finding.

### The eight, and why they are not one thing

A port method with no caller is not merely idle. **A port is the contract a module offers the rest of the application** — ADR-017 makes it the boundary, and the persistence layer's capability list is *supposed* to stop there. A method on it is a promise, and the eight were making three different kinds of bad promise.

**1. A door around a guarantee.** `IStockCachePort.get` / `.set`.

[ADR-023](023-cache-invalidate-post-commit-by-type.md) removed public `invalidate` from this port on the reasoning that a cache mutation must be *type-level* impossible to issue from inside a transaction — a pre-commit invalidate is repopulated by a concurrent reader with pre-commit data and stays stale forever. It made `invalidatePrefixes` private, kept `withInvalidation` as the only door, and called the ordering enforced.

It left `set` public. **A `set` of pre-commit data is exactly as permanently stale as a pre-commit `invalidate`** — the same failure, reached by the next method along. The invariant was never enforced; it was enforced against one of its two entrances. Nothing exploited the hole because nothing called `get` or `set` at all: `getOrLoad`, in the adapter itself, was their only caller.

**2. A door into a room the design forbids.** `IAddressRepositoryPort.findByOwner`.

`Address` is polymorphic over `ownerType ∈ {customer, order}`, and `README.md` §5 is explicit that an order's addresses are *immutable snapshot copies, **never references into a customer address book***. `findByOwner(CUSTOMER, customerId)` returns a customer's address book. It is the query for the concept the design exists to rule out — sitting on the port, implemented, spec'd, and described by a comment claiming it was "the read the order view uses to resolve an order's snapshotted billing/shipping rows".

The order view resolves nothing. It surfaces `billingAddressId` / `shippingAddressId` and stops. **The `Address` port is write-only in fact, and now it is write-only in type.**

**3. A second door to the same room.** `IStaffUserRepositoryPort.softDelete`.

Deactivating a staff user has two implementations in this codebase and zero callers of either: `StaffUser.suspend()` flips `status`, which is what `existsActiveById` gates the JWT on; `softDelete` sets `deleted_at` on the row. `README.md` §14 names the first as the seam for the deactivation route that does not exist yet ([ADR-047](047-staff-user-creation-over-http.md) closed the sibling gap and left this one recorded). Two mechanisms for one operation, where the redundant one contradicts the status model the guard actually reads, is worse than none.

**4. And three that are just unused reads.** `findById` on the `Address`, `Category` and `Refund` ports; `findAll` on the `Permission` port. Nobody addresses a refund on its own (Issue Refund reads a payment's history via `findByPaymentId`); nobody addresses a category by id (callers name a `slug`, subtree reads use `path`); there is no "list every permission" route, and `PermissionCodeEnum` — not the table — is the source of truth for which codes exist.

These four are the weakest part of this ADR, and it is worth saying so plainly. Each is three correct lines. But each also carries an adapter implementation and a spec block, and — this is the part that decides it — **each is on a port**, which is where a method stops being three lines and becomes a claim about what the module is for.

### The comments, again

Three of the eight carried a comment asserting a caller that does not exist (`findByOwner`: "the read the order view uses"; `IRefundRepositoryPort.findById`: "scope-aware so Issue Refund can re-read inside its transaction" — Issue Refund does not call it; `EmailNotifierAdapter` in ADR-048: "so the DI slot stays visible"). That is now three ADRs running. **The comment that vouches for a caller is the reliable smell**; the code that has real callers rarely needs to say so.

## Decision

### 1. `get` / `set` are private to `StockCache`; the port carries `getOrLoad` + `withInvalidation`

The same operation ADR-023 performed on `invalidate`, applied to the entrance it missed. The port now offers two *composed* operations and no raw access to the key. There is no way, from a use case, to write a value into the stock cache except as the write-back of a load that just happened.

The nine unit tests that drove `get` / `set` directly now drive the same two code paths through `getOrLoad`. Nothing is asserted less precisely for it — the exact key strings, the tenant segment, both log lines and the ±10 % TTL band are all still pinned. A test that reaches past the public surface to the method under it was, in hindsight, the thing that made the hole comfortable.

### 2. Remove the other six from their ports

`findByOwner`, `findById` (`Address`, `Refund`), `findAll` (`Permission`), `softDelete` (`StaffUser`) are deleted from port, adapter and spec. `ICategoryRepositoryPort.findById` is deleted from the *port* and made **private** on the adapter — `save`'s re-read is a real caller, just not an application-layer one.

The two specs that called the staff double's `softDelete` to simulate a vanished user now call a `remove(id)` helper on the double, named so it cannot be mistaken for the port: arrangement, not contract.

### 3. What this does not extend to

ADR-048 §3 kept 99 over-exported file-local types, and this ADR does not reverse that. The distinction is not size, it is **audience**: `IProductProps` is a wider door on a room only its own file enters, and a port method is a door the whole application is invited through. The first is untidy; the second is a promise.

## Consequences

### Positive

- ADR-023's invariant is now actually enforced, rather than enforced against one of two entrances. This is the substantive win, and it is a **correctness** win, not a tidiness one — it was reachable, and it was one `stockCache.set(...)` inside a transaction away from being real.
- `IAddressRepositoryPort` is write-only in type, so the customer address book README rules out is no longer a method call away.
- Staff deactivation has one mechanism instead of two, and it is the one the JWT guard reads.
- 246 port methods, **zero** with no caller.

### Negative

- The four plain reads are a small win against real `git blame` churn, and the next use case that wants `refund.findById` will rewrite three lines. Accepted on the reasoning in §4 above; it is the thinnest argument in this ADR.

### Open

- Nothing enforces this. A port method with no caller is not a lint error and cannot easily become one — `boundaries` reasons about imports, not about call graphs. The check is a script, run when someone thinks to run it, which is precisely how the eight accumulated.

## Alternatives considered

- **Keep `get` / `set` public and just drop them from the port.** Half the fix. The adapter is registered bare in the module (so `useExisting` can alias it), so a public `set` on the class is reachable by anyone who injects the class instead of the port. ADR-023's precedent — `invalidatePrefixes` is *private on the adapter* — settles it.
- **Rewrite the nine cache tests to call `adapter['get'](...)`.** Preserves them verbatim through TypeScript's bracket escape hatch, and preserves the habit that let the hole survive: a test that asserts on a method the design says nobody may call is a test defending the wrong thing.
- **Keep the four plain reads; they are conventional.** The argument that "the next developer will want `findById`" is the same argument ADR-046 and ADR-048 rejected for placeholders, and three lines is not a head start worth a false promise on a contract.
- **Delete `StaffUser.suspend()` too, and let `softDelete` be the deactivation.** Backwards: `existsActiveById` — the hot-path JWT check — reads `status`. The mechanism the guard consults is the one that survives.

---

## References

- [ADR-023](023-cache-invalidate-post-commit-by-type.md) — removed public `invalidate` for exactly the reason `set` is removed here; amended.
- [ADR-012](012-stock-aggregate-and-port-adapter.md) — describes `IStockCachePort.get`'s return shape (CACHE-005); amended to say it is internal.
- [ADR-017](017-conventions-and-boundaries.md) — makes the port the boundary, which is what gives an uncalled port method its cost.
- [ADR-047](047-staff-user-creation-over-http.md) / [ADR-048](048-two-scaffold-adapters-that-were-never-wired.md) — the two levels of the same sweep above this one.
