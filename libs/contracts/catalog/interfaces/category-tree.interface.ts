import { ICorrelationPayload } from '../../microservices';

// Wire-format query for `catalog.category.get-tree` (API Gateway → Catalog) — the
// nested active subtree rooted at one category. Carries a `correlationId` for
// log/trace correlation.
//
// `slug` identifies the root of the subtree to return; the category is addressed
// by **slug**, the stable handle the gateway holds. A missing OR archived
// category is a 404 (the tree is a browse read and an archived category is hidden
// from browse) — the use case resolves the slug to a row and enforces both.
export interface ICategoryTreeQuery extends ICorrelationPayload {
  slug: string;
}
