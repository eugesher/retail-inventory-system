import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `inventory.stock.low` event published by the
// inventory microservice when a product's available quantity in a storage
// drops at or below the configured low-stock threshold. Framework-free.
export interface IInventoryStockLowEvent extends ICorrelationPayload {
  productId: number;
  storageId: string;
  quantity: number;
  threshold: number;
  occurredAt: string;
}
