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

// The opaque scope handed to the work callback. The `unique symbol` brand prevents an object
// literal from satisfying the type — only the TypeORM adapter constructs values, and it does
// so through an `as unknown as` cast that is deliberately confined to that one file.
export interface ITransactionScope {
  readonly __transactionScope: unique symbol;
}

export const TRANSACTION_PORT = Symbol('TRANSACTION_PORT');

export interface ITransactionPort {
  runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T>;
}
