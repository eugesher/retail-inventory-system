import { ICorrelationPayload } from '../../microservices';

export interface IPriceQuery extends ICorrelationPayload {
  variantId: number;
  currency: string;
  asOf?: string;
}
