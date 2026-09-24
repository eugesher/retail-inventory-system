import { ICorrelationPayload } from '../../microservices';

export interface ICreateTaxCategoryPayload extends ICorrelationPayload {
  code: string;
  name: string;
  description?: string;
}
