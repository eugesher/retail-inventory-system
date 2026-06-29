// Internal retry signal for the optimistic write path (ADR-027 concurrency
// hardening). Thrown by `StockTypeormRepository.persistStockLevelChange` when:
//   * a version-checked UPDATE matches zero rows — a concurrent writer advanced
//     the row's optimistic-lock `version` between our read and our write; or
//   * a first-touch INSERT loses the `UNIQUE (variant_id, stock_location_id)`
//     race to a concurrent writer that created the row first.
//
// Caught by `applyOnHandChange`, which re-reads the now-current row and retries
// a bounded number of times; on exhaustion it is rethrown as an
// `InventoryDomainException(STOCK_WRITE_CONFLICT)` (a 409). It is deliberately
// NOT an `InventoryDomainException`: it is an infrastructure-level concurrency
// signal, not a domain-invariant violation, so it must not leak to the caller
// unchanged and must not be mapped directly by the presentation filter.
export class StockWriteConflictError extends Error {
  constructor(
    public readonly variantId: number,
    public readonly stockLocationId: string,
    // The optimistic-lock version our compare-and-swap targeted (the `from` version we
    // read the row at and lost the race against), surfaced so `runWithStockWriteRetry`
    // can log it on the `info` retry trace (ADR-036). `null` on a first-touch INSERT race
    // (no prior version existed) and on the reservation UNIQUE-triple translation.
    public readonly expectedVersion: number | null = null,
  ) {
    super(`Optimistic write conflict on stock level (variant ${variantId} @ ${stockLocationId})`);
    this.name = 'StockWriteConflictError';
  }
}
