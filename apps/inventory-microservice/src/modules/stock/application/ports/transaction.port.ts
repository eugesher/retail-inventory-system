// Opaque unit-of-work token. The application layer receives this value from
// `ITransactionPort.runInTransaction` and threads it back through repository
// port methods that participate in the same transaction. Only the transaction
// adapter knows the concrete shape (a TypeORM `EntityManager`); the
// application layer never inspects it. The branded `__transactionScope`
// property prevents accidental cross-cast from arbitrary values.
export interface ITransactionScope {
  readonly __transactionScope: unique symbol;
}

export const TRANSACTION_PORT = Symbol('TRANSACTION_PORT');

// Inbound port that owns the transaction lifecycle. The adapter is the
// TypeORM-backed `TypeormTransactionAdapter`; use cases call
// `runInTransaction` to acquire an `ITransactionScope` they pass into
// repository methods, never reaching for `EntityManager.transaction`
// directly.
export interface ITransactionPort {
  runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T>;
}
