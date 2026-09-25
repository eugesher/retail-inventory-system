import { ICorrelationPayload } from '../../microservices';

export interface IReclassifyProductPayload extends ICorrelationPayload {
  productId: number;
  attachCategorySlugs: string[];
  detachCategorySlugs: string[];
}
