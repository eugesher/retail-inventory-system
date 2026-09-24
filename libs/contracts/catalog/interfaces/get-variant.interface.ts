import { ICorrelationPayload } from '../../microservices';

export interface IGetVariantQuery extends ICorrelationPayload {
  variantId: number;
}
