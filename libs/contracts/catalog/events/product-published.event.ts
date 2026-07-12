import { ICorrelationPayload } from '../../microservices';

// `catalog.product.published` — a **reserved surface** (README §2). Not dead code.
//
// The payload carries `variantIds`, not just the product id, because everything downstream of
// catalog keys on the **variant** (ADR-025) — a consumer that only learned the product id would
// have to read the variants back.
//
// `publishedAt` is the business instant of the `draft → active` transition; `occurredAt` is the
// envelope's. They are separate fields carrying the same value, and a consumer must not assume
// they always will.
export interface ICatalogProductPublishedEvent extends ICorrelationPayload {
  productId: number;
  slug: string;
  variantIds: number[];
  publishedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
