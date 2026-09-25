import { ICorrelationPayload } from '../../microservices';

export interface ICreateCategoryPayload extends ICorrelationPayload {
  name: string;
  slug: string;
  parentSlug?: string;
  sortOrder?: number;
}
