import { ICorrelationPayload } from '../../microservices';

export interface IPublishProductPayload extends ICorrelationPayload {
  productId: number;
}
