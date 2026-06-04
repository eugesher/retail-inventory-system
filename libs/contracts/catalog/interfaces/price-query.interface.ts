import { ICorrelationPayload } from '../../microservices';

// Wire-format query payload shared by `catalog.price.list` and
// `catalog.price.select` (API Gateway → Catalog). Both ask the same question
// over the same `(variantId, currency)` scope at a point in time:
//
//   * `catalog.price.list`   → every Price row in effect at `asOf`.
//   * `catalog.price.select` → the single applicable Price at `asOf`, resolved by
//     priority then recency (or `null` when none is in effect).
//
// `asOf` is the as-of instant (ISO-8601); omitted means "now". The currency
// scope is required on the wire — defaulting it is a gateway-DTO concern, not a
// contract one.
export interface IPriceQuery extends ICorrelationPayload {
  variantId: number;
  currency: string;
  asOf?: string;
}
