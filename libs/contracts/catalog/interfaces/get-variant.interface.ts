import { ICorrelationPayload } from '../../microservices';

// Wire-format query for `catalog.variant.get` (API Gateway → Catalog) — fetch a
// single variant by its id, together with its parent product header. The variant
// is the downstream backbone key (inventory stock, pricing, order lines key on
// `variantId` — ADR-025), so it is addressable on its own on the read path even
// though it is only mutated through the `Product` root on the write path. An
// archived variant/product stays resolvable here so historical order/stock
// references never dangle. Carries a `correlationId` for log/trace correlation.
export interface IGetVariantQuery extends ICorrelationPayload {
  variantId: number;
}
