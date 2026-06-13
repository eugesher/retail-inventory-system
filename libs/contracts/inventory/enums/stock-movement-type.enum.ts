// The typed vocabulary of a `stock_movement` row — the six kinds of change the
// inventory ledger records, each with a FIXED sign (ADR-030 §2):
//
//   positive (stock entering on-hand)        → receipt, return
//   negative (stock leaving / hold torn down) → sale, allocation, release
//   either non-zero sign (operator's delta)  → adjustment
//
// All six ship as the complete type set even though `sale` / `return` gain
// producers only with the later fulfilment / returns capabilities — the enum is
// the whole vocabulary ADR-030 pins, so a movement row never needs a schema
// change to record a kind that was always foreseen.
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
