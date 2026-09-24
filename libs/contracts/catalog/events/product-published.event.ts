import { ICorrelationPayload } from '../../microservices';

export interface ICatalogProductPublishedEvent extends ICorrelationPayload {
  productId: number;
  slug: string;
  variantIds: number[];
  publishedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
