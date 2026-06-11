import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.product.reclassify` (API Gateway →
// Catalog) — a bulk attach + detach of a product's category memberships in one
// command. Carries a `correlationId` for log/trace correlation.
//
// `productId` is the product whose membership changes. `attachCategorySlugs` and
// `detachCategorySlugs` each name categories by **slug** (the stable handle the
// gateway holds); EITHER list may be empty. A single RPC serves both gateway
// routes — the attach route sends only `attachCategorySlugs` (detach empty), the
// detach route only `detachCategorySlugs` (attach empty). Both lists are applied
// idempotently: re-attaching an existing membership and detaching a non-membership
// are silent successes (the `INSERT IGNORE` / `DELETE` semantics).
export interface IReclassifyProductPayload extends ICorrelationPayload {
  productId: number;
  attachCategorySlugs: string[];
  detachCategorySlugs: string[];
}
