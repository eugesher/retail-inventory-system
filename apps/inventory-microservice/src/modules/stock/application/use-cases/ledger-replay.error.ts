// Internal replay signal for the two ledger-deduped writes (Commit Sale, ADR-031;
// Restock From Return, ADR-032). Thrown from INSIDE the write transaction when its own
// snapshot already contains the `sale` / `return` movement for this business document —
// i.e. a concurrent delivery committed first and we can see it.
//
// **Why a signal and not just the UNIQUE.** `UC_STOCK_MOVEMENT_DEDUPE` catches the
// interleaving where neither transaction sees the other, so both write and the loser's
// INSERT breaks. It CANNOT catch the interleaving where the loser opens its transaction
// after the winner committed: the loser re-reads a level whose `quantity_allocated` the
// winner already consumed, and `StockLevel.commitSale` treats shipping more than is
// allocated as internal drift and throws a plain `Error` — a 500 out of an
// `@MessagePattern`, which the broker then blind-redelivers in a hot loop. The drift
// check fires in phase 2, long before any INSERT could reach the constraint in phase 3.
//
// So the two mechanisms cover DISJOINT windows and both are required:
//   * the loser's snapshot SEES the winner    → this signal (probe under the scope);
//   * neither snapshot sees the other         → `UC_STOCK_MOVEMENT_DEDUPE`.
// The pre-transaction `existsByReference` probe covers neither — it is only the cheap
// short-circuit for a sequential replay.
//
// Deliberately NOT an `InventoryDomainException`: nothing is wrong. It is a control
// signal that unwinds the transaction (so the losing attempt persists nothing) and is
// translated by the use case into the SAME successful no-op a sequential replay returns.
// It is not a `StockWriteConflictError` either — `runWithStockWriteRetry` must not retry
// it, because a retry would re-read the same committed row and lose again, every time.
export class LedgerReplayError extends Error {
  constructor(
    public readonly referenceType: string,
    public readonly referenceId: string,
  ) {
    super(`Ledger already holds ${referenceType} ${referenceId} — this delivery is a replay`);
    this.name = 'LedgerReplayError';
  }
}
