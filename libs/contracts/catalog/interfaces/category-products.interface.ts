import { ICorrelationPayload } from '../../microservices';

export interface ICategoryProductsQuery extends ICorrelationPayload {
  slug: string;
  includeDescendants?: boolean;
  page?: number;
  pageSize?: number;
}
