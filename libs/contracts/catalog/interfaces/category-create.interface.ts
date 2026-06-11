import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.category.create` (API Gateway →
// Catalog). Carries a `correlationId` for log/trace correlation.
//
// `parentSlug` is optional: when present the new category hangs off that parent
// (the use case resolves the parent by slug and the model derives the child
// `path` from `parent.path`); when omitted the category is a root
// (`path = '/<slug>'`). `sortOrder` is optional — the domain defaults a missing
// value to 0. The parent is addressed by **slug**, not id: a slug is the stable,
// human-supplied handle the gateway already knows, and the create use case is the
// only place that needs to resolve it to a row.
export interface ICreateCategoryPayload extends ICorrelationPayload {
  name: string;
  slug: string;
  parentSlug?: string;
  sortOrder?: number;
}
