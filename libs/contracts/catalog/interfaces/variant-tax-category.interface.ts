import { ICorrelationPayload } from '../../microservices';

export interface IAttachVariantTaxCategoryPayload extends ICorrelationPayload {
  variantId: number;
  taxCategoryCode: string;
}
