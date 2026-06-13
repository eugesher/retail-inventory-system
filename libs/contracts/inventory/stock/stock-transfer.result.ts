import { StockLevelView } from './stock-level.view';

// RPC response for `inventory.stock-level.transfer`. Both legs of the move are
// returned post-transfer so a caller sees the new running totals at each end in a
// single round-trip: `from` is the debited source level, `to` is the credited
// destination level (each the same single-location `StockLevelView` the Receive /
// Adjust writes return). ADR-030.
export interface IStockTransferResult {
  from: StockLevelView;
  to: StockLevelView;
}
