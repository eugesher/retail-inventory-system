import { ICorrelationPayload } from '../../microservices';

export interface IInventoryStockReservedEvent extends ICorrelationPayload {
  reservationId: string;
  variantId: number;
  stockLocationId: string;
  quantity: number;
  cartId: string;
  expiresAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
