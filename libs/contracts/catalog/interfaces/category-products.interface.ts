import { ICorrelationPayload } from '../../microservices';

// Wire-format query for `catalog.category.list-products` (API Gateway → Catalog)
// — the paged active products attached to a category. Carries a `correlationId`
// for log/trace correlation.
//
// `slug` identifies the category (a missing/archived category is a 404, the same
// rule as the tree read). `includeDescendants` widens the scope from the single
// category to the category PLUS its active subtree (every product in any
// descendant category) when set; it defaults off (the named category only).
// `page` is 1-based and `pageSize` optional — the use case applies its own
// defaults when they are absent (the gateway normalizes them at the edge later).
export interface ICategoryProductsQuery extends ICorrelationPayload {
  slug: string;
  includeDescendants?: boolean;
  page?: number;
  pageSize?: number;
}
