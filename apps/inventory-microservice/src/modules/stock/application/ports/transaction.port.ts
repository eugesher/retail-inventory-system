// The `unique symbol` brand prevents an object literal from satisfying
// the type — only the TypeORM adapter constructs values (`as unknown as`).
export interface ITransactionScope {
  readonly __transactionScope: unique symbol;
}

export const TRANSACTION_PORT = Symbol('TRANSACTION_PORT');

export interface ITransactionPort {
  runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T>;
}
