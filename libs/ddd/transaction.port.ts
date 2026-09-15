// The transaction seam: the application layer's way to compose several repository writes
// into one atomic unit WITHOUT ever naming TypeORM. A use case asks the port to run its
// work; the port hands back an opaque scope; the use case passes that scope down into the
// repository-port methods. Only the infrastructure adapter knows the scope is really an
// `EntityManager` (`TypeormTransactionAdapter`, `libs/database`).
//
// It lives in `libs/ddd`, not `libs/database`, on purpose — and the boundaries taxonomy is
// what forces the split (ADR-017). `application/ports` may import only `lib-ddd` and
// `lib-contracts`, and `application/use-cases` may not import `lib-database` at all; a
// transaction port declared in the database lib would therefore be unreachable from the two
// layers that exist to consume it. Framework-free is not a stylistic preference here, it is
// the precondition for the seam working.
//
// Shared by every module that needs a multi-repository write — inventory `stock`, retail
// `orders`, retail `returns` (ADR-043). Each used to carry a byte-identical private copy.

// The opaque scope handed to the work callback.
//
// **The cast has two directions** (ADR-054 — ADR-017 §6 conflated them and predicted the wrong
// number), **and both live in `libs/database/typeorm-transaction.adapter.ts`**:
//
//   * **CONSTRUCTING** a scope (`EntityManager` → `ITransactionScope`) happens in **exactly one place**,
//     `TypeormTransactionAdapter.runInTransaction`, and the `unique symbol` brand is what confines it:
//     no object literal can satisfy this type, so nothing else can mint one.
//   * **CONSUMING** a scope (`ITransactionScope` → `EntityManager`) is needed by **every repository that
//     accepts one** — an opaque handle that must be *used* has to be un-opaqued once per user. Each of
//     them calls `entityManagerOf(scope)` rather than casting inline (it used to be 14 inline casts in
//     11 files), and a `no-restricted-syntax` rule rejects a new `as EntityManager` in `apps/`. A new
//     repository that joins a transaction calls the helper; that is the idiom, and it needs no ADR.
//
// **The invariant is not "few casts" — it is that `EntityManager` never reaches `application/`**, which
// the `application-use-case` / `application-port` denylists enforce and `spec/architecture-lint.spec.ts`
// guards against being weakened.
export interface ITransactionScope {
  readonly __transactionScope: unique symbol;
}

export const TRANSACTION_PORT = Symbol('TRANSACTION_PORT');

export interface ITransactionPort {
  runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T>;
}
