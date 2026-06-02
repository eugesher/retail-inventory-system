import { ICorrelationPayload } from '../../microservices';

// Wire-format query for `catalog.product.list` (API Gateway → Catalog) — the
// Customer-facing browse of the published catalogue. Carries a `correlationId`
// for log/trace correlation.
//
// `status` defaults to `active` on the read side: browse hides non-active
// products (a `draft` is invisible until published; an `archived` product drops
// out of the catalogue but stays resolvable by id/slug — ADR-025). The field is
// present for forward-compatibility, but the read path serves the active
// catalogue today. `page` is 1-based; `pageSize` and `search` are optional —
// the use case applies its own defaults when they are absent.
export interface IListProductsQuery extends ICorrelationPayload {
  status?: 'active' | 'draft' | 'archived';
  page?: number;
  pageSize?: number;
  search?: string;
}
