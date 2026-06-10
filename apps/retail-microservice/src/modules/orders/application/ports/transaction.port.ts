// The transactional unit-of-work seam for the orders context, mirroring the
// inventory `modules/stock` adapter exactly (ADR-017 §6 / ADR-019). Place Order
// persists across three aggregates in one transaction — the `Order` root + its
// lines, the two snapshot `Address`es, and the cart-conversion write — so the use
// case must hand one scope to every repository it touches without ever seeing an
// `EntityManager`.
//
// The `unique symbol` brand prevents an object literal from satisfying the type —
// only the TypeORM adapter constructs values (`as unknown as`), so the
// `EntityManager` downcast lives only in the adapter + the repositories, never in a
// use case (which the boundaries lint keeps `typeorm`-free).
export interface ITransactionScope {
  readonly __transactionScope: unique symbol;
}

export const TRANSACTION_PORT = Symbol('TRANSACTION_PORT');

export interface ITransactionPort {
  runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T>;
}
