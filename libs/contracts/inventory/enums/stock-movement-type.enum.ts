// The typed vocabulary of a `stock_movement` row — the six kinds of change the
// inventory ledger records, each with a FIXED sign (ADR-030 §2):
//
//   positive (stock entering on-hand)        → receipt, return
//   negative (stock leaving / hold torn down) → sale, allocation, release
//   either non-zero sign (operator's delta)  → adjustment
//
// All six are produced today: `receipt` by Receive, `adjustment` by Adjust AND by
// Transfer (which writes TWO of them — one out, one in — under a single `transfer`
// reference id, so `(reference_type, reference_id)` is NOT unique for a transfer),
// `allocation` by Allocate, `release` by Release / Cancel-allocation / the TTL
// sweep, `sale` by Commit-sale, `return` by Restock-from-return.
//
// This is a WIRE CONTRACT: it rides `StockMovementView`, the audit list query
// payload, and the future `inventory.stock-movement.recorded` event, so it lives
// in `libs/contracts` — unlike the lifecycle `ReservationStatusEnum`, which is an
// internal domain concept and stays in the inventory `domain/` (ADR-025 §7).
export enum StockMovementTypeEnum {
  RECEIPT = 'receipt',
  ADJUSTMENT = 'adjustment',
  ALLOCATION = 'allocation',
  SALE = 'sale',
  RELEASE = 'release',
  RETURN = 'return',
}
