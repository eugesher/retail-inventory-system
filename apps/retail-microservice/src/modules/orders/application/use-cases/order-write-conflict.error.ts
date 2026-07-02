// Internal retry signal for the order optimistic-concurrency write path (ADR-036).
// Thrown by `OrderTypeormRepository.save` when the version-checked compare-and-swap
// on the order root matches zero rows — a concurrent writer advanced the row's
// optimistic-lock `version` between our read and our write (two staff editing one
// order, a capture racing a ship of another fulfillment, etc.).
//
// Caught by `runWithOrderWriteRetry`, which re-reads the now-current order under a
// fresh transaction and retries a bounded number of times; on exhaustion it is
// rethrown as an `OrderDomainException(ORDER_VERSION_MISMATCH)` (a 409 carrying
// `details.currentVersion`). It is deliberately NOT an `OrderDomainException`: it is
// an infrastructure-level concurrency signal, not a domain-invariant violation, so it
// must not leak to the caller unchanged and must not be mapped directly by the
// presentation filter (the inventory `StockWriteConflictError` / cart
// `CartWriteConflictError` precedent).
export class OrderWriteConflictError extends Error {
  constructor(
    public readonly orderId: number,
    // The row's now-current optimistic-lock version, re-read after the CAS lost the
    // race (a fresh committed read, so the value the winner left behind). Surfaced so
    // `runWithOrderWriteRetry` can put it in `details.currentVersion` and log it on the
    // retry trace, letting the caller refetch-and-retry.
    public readonly currentVersion: number,
  ) {
    super(`Optimistic write conflict on order ${orderId} (current version ${currentVersion})`);
    this.name = 'OrderWriteConflictError';
  }
}
