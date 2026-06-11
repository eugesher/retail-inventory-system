import { ICorrelationPayload } from '../../microservices';

// Wire-format query for `catalog.category.list` (API Gateway → Catalog) — the
// flat list of categories for a store-front navigation menu. Carries a
// `correlationId` for log/trace correlation.
//
// `rootOnly` keeps only top-level categories (`parentId IS NULL`) when set; it is
// optional and defaults off (every category) at the use case. The list is a
// public browse read, so it always returns ACTIVE categories only — an archived
// category is hidden, so there is no status field to choose.
export interface ICategoryListQuery extends ICorrelationPayload {
  rootOnly?: boolean;
}
