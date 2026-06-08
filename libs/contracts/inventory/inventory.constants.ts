// The id of the single auto-provisioned default StockLocation (the migration
// seeds exactly this row idempotently). Cross-service constant so the auto-init
// consumer and later inventory operations key on one agreed default.
export const INVENTORY_DEFAULT_STOCK_LOCATION = 'default-warehouse';

// Quantity-at-or-below threshold that fires an `inventory.stock.low` event.
// Cross-service constant so producers and consumers agree on the trigger value.
export const INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD = 5;
