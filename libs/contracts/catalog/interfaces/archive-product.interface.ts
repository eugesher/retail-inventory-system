import { ICorrelationPayload } from '../../microservices';

export interface IArchiveProductPayload extends ICorrelationPayload {
  productId: number;
}
