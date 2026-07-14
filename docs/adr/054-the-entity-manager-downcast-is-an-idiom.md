# ADR-054: The `EntityManager` downcast is an idiom, not an exception — and ADR-017 §6 counted the wrong thing

- **Date**: 2026-07-13
- **Status**: Accepted

---

## Context

[ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6 closed `ARCH-LINT-EX-01` — the exception
that let TypeORM's `EntityManager` cross the application/infrastructure boundary — and wrote down where
the cast that replaced it lives:

> *"The downcast back to `EntityManager` lives only in the **two** infrastructure-layer adapters:
> `TypeormTransactionAdapter` … `StockTypeormRepository` casts it back when it needs the manager for
> query construction."*

**That is now false.** `grep -rn "as unknown as EntityManager" apps/` returns **14 sites in 11 files**,
across `orders/`, `returns/` and `stock/`.

An accepted ADR is immutable ([ADR-003](003-record-architecture-decisions.md)), so this is not an edit
to §6. It is the ADR that says what §6 got wrong, and — more usefully — **why it was always going to be
wrong**, and what the closure of `ARCH-LINT-EX-01` actually bought.

### The cast has two directions, and §6 conflated them

This is the whole finding.

| direction | what it does | sites |
| --- | --- | --- |
| **construct** — `EntityManager` → `ITransactionScope` | mints a scope value | **1** — `libs/database/typeorm-transaction.adapter.ts:29` |
| **consume** — `ITransactionScope` → `EntityManager` | un-opaques it to build a query | **14**, in 11 repositories |

§6 named one of each (`TypeormTransactionAdapter` constructs; `StockTypeormRepository` consumes) and
called them *"the two adapters"* — as though they were two instances of one thing that would stay at
two. **They are two different things with two different growth laws.**

- **Construction is genuinely confined, and the type system enforces it.** `ITransactionScope` is
  branded with a `unique symbol`, so no object literal can satisfy it: **the only way to mint a scope
  is that one cast, in that one file.** It has not grown and it cannot.
- **Consumption grows with the system, by construction.** An opaque handle that must be *used* has to
  be un-opaqued **once per user**. The number of downcasts is exactly the number of repositories that
  join a caller's transaction — and every aggregate that participates in a transactional write adds
  one. It was 1. It is 14. It will be 15.

**That is not drift. It is the arithmetic of an opaque type.** §6 did not mis-observe the codebase; it
mis-predicted a number that was never going to hold still, and it did so by counting *casts* instead of
naming the *rule*.

### What the closure of `ARCH-LINT-EX-01` actually bought — and it is intact

Not *"the cast is confined to two files"*. That was never the guarantee, and it is gone.

The guarantee is: **`EntityManager` never reaches `application/`.** Verified across the whole tree —
not one `import … from 'typeorm'` and not one `@nestjs/typeorm` import in any module's `application/`
layer. A use case acquires an opaque `ITransactionScope` from `ITransactionPort` and passes it into a
repository port; it cannot construct one, cannot inspect one, and cannot call a method on one.

**And that guarantee is enforced, not merely documented**: the `application-use-case` and
`application-port` denylists in `eslint.config.mjs` forbid both `typeorm` and `@nestjs/typeorm`, and
since ISSUE-10 (`ef44633`) `spec/architecture-lint.spec.ts` lints against the **resolved production
config**, so weakening either denylist turns the suite red.

## Decision

> **The `ITransactionScope` → `EntityManager` downcast is an INFRASTRUCTURE IDIOM.** It is expected in
> any repository that accepts a scope, it is not an exception, it is not counted, and it does not need
> an ADR when the twelfth one appears.
>
> **The invariant is not "few casts". It is "`EntityManager` never appears in `application/`"** — and
> that is what lint enforces and what the architecture-lint suite guards.

Two consequences worth stating explicitly, because they are the two ways a future reader could get this
wrong:

1. **A new repository that accepts an `ITransactionScope` MAY downcast it.** That is the price of an
   opaque scope and it is the price we chose. Do not open an exception, do not ask for one, and do not
   add it to a register.
2. **Nothing else may.** The cast belongs in `infrastructure/persistence/`. A downcast anywhere in
   `application/` is not an idiom — it is the boundary breach `ARCH-LINT-EX-01` existed to close, and
   the denylist will reject the import it requires before the cast even compiles.

### `ADR-017` is not superseded

Only §6's factual claim about the *count* is. Everything else in ADR-017 — the taxonomy, the
denylists, the CI strategy, `ARCH-LINT-EX-02` — stands, and ADR-017 stays `Accepted` with a one-line
pointer to this ADR.

### The comment on `ITransactionScope` is clarified, not corrected

`libs/ddd/transaction.port.ts` says the cast *"is deliberately confined to that one file"*. Read
narrowly that is **true** — it is talking about **construction**, and construction *is* confined to one
file. Read quickly it invites exactly ADR-017 §6's mistake. It now names the direction it means.

## Consequences

### Positive

- **The map stops lying about a number.** It already carried the correction informally (*"11
  files … that is what an opaque scope costs"*); this makes it a decision rather than a marginal note.
- **The next repository does not have to wonder.** A developer adding an aggregate that joins a
  transaction currently reads §6, finds their file is not one of "the two", and has to decide whether
  they are breaking a rule. They are not. Now the ADR says so.
- **The guarantee that matters is stated where it can be checked**, and it *is* checked.

### Negative

- **An `as unknown as` in fourteen places is an ugliness, and calling it an idiom does not make it
  pretty.** It is a hole in the type system, opened deliberately, once per repository. The honest
  defence is that the alternative — an `EntityManager` in the port signature — is a hole in the
  *architecture*, and a type-system hole confined to `infrastructure/` is the cheaper one.
- **Nothing prevents a downcast to the *wrong* manager.** The brand guarantees the value came from
  `TypeormTransactionAdapter`; it does not guarantee it came from *this* transaction. Passing a stale
  scope across transactions would type-check. No instance exists, and none is likely — a scope is a
  callback parameter and does not outlive its callback — but the type system is not what stops it.

### Open

- **A typed scope would remove the cast entirely.** `ITransactionScope` could carry the manager behind
  an interface (`getRepository<T>(...)`) rather than being a naked brand, and repositories would call
  it instead of casting. It would cost `libs/ddd` a TypeORM-shaped abstraction it currently does not
  have — which is exactly what ADR-017 forbade — so it needs a way to express "a repository handle"
  without naming TypeORM. **Not attempted; recorded because the current design's ugliness is real and
  someone will want to fix it.**

## References

- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6 — the claim this supersedes. Stays
  `Accepted`; the rest of it holds.
- [ADR-043](043-lifting-forced-duplicates-into-shared-libs.md) — lifted `ITransactionPort` /
  `ITransactionScope` into `libs/ddd`, collapsing three identical copies.
- ISSUE-10 (`ef44633`) — why *"lint enforces it"* is now a statement with a test behind it rather than a
  hope: `spec/architecture-lint.spec.ts` lints the resolved production config, so weakening the
  `application-*` denylists turns the suite red.
