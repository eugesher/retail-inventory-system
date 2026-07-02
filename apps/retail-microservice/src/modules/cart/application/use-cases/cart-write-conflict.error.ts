// Internal retry signal for the cart optimistic-concurrency write path (ADR-036).
// Thrown by `CartTypeormRepository.save` when the version-checked compare-and-swap
// on the cart root matches zero rows — a concurrent writer advanced the row's
// optimistic-lock `version` between our read and our write.
//
// Caught by `runWithCartWriteRetry`, which re-reads the now-current cart and
// retries a bounded number of times; on exhaustion (or immediately, when the
// client pinned an `If-Match` version) it is rethrown as a
// `CartDomainException(CART_VERSION_MISMATCH)` (a 409 carrying
// `details.currentVersion`). It is deliberately NOT a `CartDomainException`: it is
// an infrastructure-level concurrency signal, not a domain-invariant violation, so
// it must not leak to the caller unchanged and must not be mapped directly by the
// presentation filter (the inventory `StockWriteConflictError` precedent).
export class CartWriteConflictError extends Error {
  constructor(
    public readonly cartId: string,
    // The row's now-current optimistic-lock version, re-read after the CAS lost
    // the race (a fresh committed read, so the value the winner left behind).
    // Surfaced so `runWithCartWriteRetry` can put it in `details.currentVersion`
    // and log it on the retry trace, letting the caller refetch-and-retry.
    public readonly currentVersion: number,
  ) {
    super(`Optimistic write conflict on cart ${cartId} (current version ${currentVersion})`);
    this.name = 'CartWriteConflictError';
  }
}
