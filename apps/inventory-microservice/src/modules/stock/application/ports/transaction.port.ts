// Opaque unit-of-work token. The `unique symbol` brand prevents an
// object literal from satisfying the type without an explicit cast —
// only the TypeORM adapter constructs values (via `as unknown as`).
export interface ITransactionScope {
  readonly __transactionScope: unique symbol;
}

export const TRANSACTION_PORT = Symbol('TRANSACTION_PORT');

export interface ITransactionPort {
  runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T>;
}
