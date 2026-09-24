import { ICorrelationPayload } from '../../microservices';

export interface ICategoryTreeQuery extends ICorrelationPayload {
  slug: string;
}
