export const INVENTORY_DEFAULT_STORAGE = 'head-warehouse';

// Quantity-at-or-below threshold that fires an `inventory.stock.low` event.
// Lives next to INVENTORY_DEFAULT_STORAGE so cross-service consumers (e.g. the
// notification microservice) can reason about the same value. ADR-012 records
// the rationale for keeping the threshold here rather than as a per-stock-row
// column or an env-only setting.
export const INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD = 5;
