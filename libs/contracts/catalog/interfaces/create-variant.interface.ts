import { ICorrelationPayload } from '../../microservices';

export interface ICreateVariantPayload extends ICorrelationPayload {
  productId: number;
  sku: string;
  gtin?: string;
  optionValues: Record<string, string>;
  weightG?: number;
  dimensionsMm?: { l: number; w: number; h: number };
}
