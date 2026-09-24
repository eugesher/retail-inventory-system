import { ICorrelationPayload } from '../../microservices';

export interface IReparentCategoryPayload extends ICorrelationPayload {
  slug: string;
  newParentSlug?: string | null;
}
