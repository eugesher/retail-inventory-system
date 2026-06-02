import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.product.register` (API Gateway →
// Catalog). Carries a `correlationId` for log/trace correlation. `description`
// is optional — the domain defaults a missing description to an empty string.
export interface IRegisterProductPayload extends ICorrelationPayload {
  name: string;
  slug: string;
  description?: string;
}
