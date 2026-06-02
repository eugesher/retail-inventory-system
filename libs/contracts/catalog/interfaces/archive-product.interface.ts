import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.product.archive` (API Gateway →
// Catalog). Identifies the product to transition `active → archived` (terminal);
// the domain rejects archiving a non-active product. Carries a `correlationId`
// for log/trace correlation.
export interface IArchiveProductPayload extends ICorrelationPayload {
  productId: number;
}
