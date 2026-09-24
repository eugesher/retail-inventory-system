import { ICorrelationPayload } from '../../microservices';

export interface IListProductsQuery extends ICorrelationPayload {
  status?: 'active' | 'draft' | 'archived';
  page?: number;
  pageSize?: number;
  search?: string;
}
