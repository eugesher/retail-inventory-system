import { ICorrelationPayload } from '../../microservices';

// Wire-format query for `catalog.product.list` (API Gateway → Catalog) — the
// Customer-facing browse of the published catalogue. Carries a `correlationId`
// for log/trace correlation.
//
// **`status` is on the payload but the read path ignores it.** Browse serves the active catalogue
// and only the active catalogue: a `draft` is invisible until published, and an `archived` product
// drops out of the list while staying resolvable by id and slug (ADR-025). Passing `draft` here
// does not surface drafts. `page` is 1-based.
export interface IListProductsQuery extends ICorrelationPayload {
  status?: 'active' | 'draft' | 'archived';
  page?: number;
  pageSize?: number;
  search?: string;
}
