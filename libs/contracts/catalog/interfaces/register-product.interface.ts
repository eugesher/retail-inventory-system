import { ICorrelationPayload } from '../../microservices';

export interface IRegisterProductPayload extends ICorrelationPayload {
  name: string;
  slug: string;
  description?: string;
}
