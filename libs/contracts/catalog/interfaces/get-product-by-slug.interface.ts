import { ICorrelationPayload } from '../../microservices';

export interface IGetProductBySlugQuery extends ICorrelationPayload {
  slug: string;
}
