// Internal retry signal for the return-request optimistic-concurrency write path
// (ADR-036). Thrown by `ReturnRequestTypeormRepository.save` when the version-checked
// compare-and-swap on the return-request root matches zero rows — a concurrent writer
// advanced the row's optimistic-lock `version` between our read and our write (two
// staff racing the same RMA's lifecycle transitions).
//
// Caught by `runWithReturnWriteRetry`, which re-reads the now-current return request
// and retries a bounded number of times; on exhaustion it is rethrown as a
// `ReturnDomainException(RETURN_VERSION_MISMATCH)` (a 409 carrying
// `details.currentVersion`). It is deliberately NOT a `ReturnDomainException`: it is an
// infrastructure-level concurrency signal, not a domain-invariant violation, so it must
// not leak to the caller unchanged and must not be mapped directly by the presentation
// filter (the cart `CartWriteConflictError` / order `OrderWriteConflictError`
// precedent). Returns cannot import the orders module (ADR-017), so this is a local
// copy — the `retry-then-log-for-replay` per-module-copy precedent.
export class ReturnWriteConflictError extends Error {
  constructor(
    public readonly rmaId: number,
    // The row's now-current optimistic-lock version, re-read after the CAS lost the
    // race (a fresh committed read, so the value the winner left behind). Surfaced so
    // `runWithReturnWriteRetry` can put it in `details.currentVersion` and log it on the
    // retry trace, letting the caller refetch-and-retry.
    public readonly currentVersion: number,
  ) {
    super(
      `Optimistic write conflict on return request ${rmaId} (current version ${currentVersion})`,
    );
    this.name = 'ReturnWriteConflictError';
  }
}
