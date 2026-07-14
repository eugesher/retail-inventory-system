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
// **The cast has two directions, and only one of them is confined** (ADR-054 — ADR-017 §6 conflated
// them and predicted the wrong number):
//
//   * **CONSTRUCTING** a scope (`EntityManager` → `ITransactionScope`) happens in **exactly one place**,
//     `libs/database/typeorm-transaction.adapter.ts`, and the `unique symbol` brand is what confines it:
//     no object literal can satisfy this type, so nothing else can mint one. It has not grown and it
//     cannot.
//   * **CONSUMING** a scope (`ITransactionScope` → `EntityManager`) happens in **every repository that
//     accepts one** — 14 sites, 11 files, and counting. That is not drift: an opaque handle that must
//     be *used* has to be un-opaqued **once per user**, so the count is exactly the number of
//     repositories that join a caller's transaction. It is an infrastructure **idiom**, not an
//     exception, and it needs no ADR when the twelfth file appears.
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
