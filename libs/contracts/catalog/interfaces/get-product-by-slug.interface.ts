import { ICorrelationPayload } from '../../microservices';

// Wire-format query for `catalog.product.get` (API Gateway → Catalog) — fetch a
// single product by its globally-unique slug, together with its active variants.
// A product is resolvable by slug regardless of status (so historical references
// stay valid); only the browse/list path filters to `active`. Carries a
// `correlationId` for log/trace correlation.
export interface IGetProductBySlugQuery extends ICorrelationPayload {
  slug: string;
}
