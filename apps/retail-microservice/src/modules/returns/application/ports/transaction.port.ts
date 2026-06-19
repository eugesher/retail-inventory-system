// The transactional unit-of-work seam for the returns context, mirroring the orders
// `modules/orders` and inventory `modules/stock` adapters exactly (ADR-017 §6 /
// ADR-019). The returns lifecycle operations persist across the `ReturnRequest`
// aggregate and (at Inspect / Close) the orders `Refund` + `Payment` writes in one
// transaction, so a use case must hand one scope to every repository it touches
// without ever seeing an `EntityManager`.
//
// The `unique symbol` brand prevents an object literal from satisfying the type —
// only the TypeORM adapter constructs values (`as unknown as`), so the `EntityManager`
// downcast lives only in the adapter + the repositories, never in a use case (which
// the boundaries lint keeps `typeorm`-free). The `ITransactionScope` type ships now so
// the repository's `save` / `findById` can accept the optional scope the later
// operations pass; the `ITransactionPort` adapter binding arrives with the use cases.
export interface ITransactionScope {
  readonly __transactionScope: unique symbol;
}

export const TRANSACTION_PORT = Symbol('TRANSACTION_PORT');

export interface ITransactionPort {
  runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T>;
}
