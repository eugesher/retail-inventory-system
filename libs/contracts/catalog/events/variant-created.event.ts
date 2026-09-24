import { ICorrelationPayload } from '../../microservices';

export interface ICatalogVariantCreatedEvent extends ICorrelationPayload {
  productId: number;
  variantId: number;
  sku: string;
  eventVersion: 'v1';
  occurredAt: string;
}
