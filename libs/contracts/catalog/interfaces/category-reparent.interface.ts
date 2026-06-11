import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.category.reparent` (API Gateway →
// Catalog). Carries a `correlationId` for log/trace correlation.
//
// `slug` identifies the category to move. `newParentSlug` is the destination
// parent: a non-null string reparents under that category (resolved by slug),
// while `null` or an omitted value **demotes the category to a root** (its
// `path` recomputes to `/<slug>`). Both nodes are addressed by **slug** — the
// stable handle the gateway holds — and the use case resolves each to a row.
export interface IReparentCategoryPayload extends ICorrelationPayload {
  slug: string;
  newParentSlug?: string | null;
}
