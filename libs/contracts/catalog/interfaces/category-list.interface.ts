import { ICorrelationPayload } from '../../microservices';

export interface ICategoryListQuery extends ICorrelationPayload {
  rootOnly?: boolean;
}
