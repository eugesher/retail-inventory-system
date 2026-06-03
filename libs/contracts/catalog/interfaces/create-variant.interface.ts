import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.variant.create` (API Gateway →
// Catalog). The variant is appended to an existing product (`productId`); `sku`
// is globally unique. `gtin`, `weightG`, and `dimensionsMm` are optional
// merchandising attributes; `optionValues` is the non-empty option map (e.g.
// `{ color: 'red', size: 'M' }`).
export interface ICreateVariantPayload extends ICorrelationPayload {
  productId: number;
  sku: string;
  gtin?: string;
  optionValues: Record<string, string>;
  weightG?: number;
  dimensionsMm?: { l: number; w: number; h: number };
}
