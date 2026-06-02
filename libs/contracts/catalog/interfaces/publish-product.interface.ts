import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.product.publish` (API Gateway →
// Catalog). Identifies the product to transition `draft → active`; the domain
// enforces the draft-state + ≥1-variant precondition. Carries a `correlationId`
// for log/trace correlation.
export interface IPublishProductPayload extends ICorrelationPayload {
  productId: number;
}
