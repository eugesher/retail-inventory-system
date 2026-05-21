export const INVENTORY_DEFAULT_STORAGE = 'head-warehouse';

// Quantity-at-or-below threshold that fires an `inventory.stock.low` event.
// Cross-service constant so producers and consumers agree on the trigger value.
export const INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD = 5;
