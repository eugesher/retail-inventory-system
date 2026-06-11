import { PriceView } from '@retail-inventory-system/contracts';

export const CART_CATALOG_GATEWAY = Symbol('CART_CATALOG_GATEWAY');

// The seam the cart write path uses to resolve a variant's applicable price at
// add-time (`catalog.price.select`). It keeps the Add-to-Cart use case free of
// any transport import (ADR-009 / ADR-020) — `CartCatalogRabbitmqAdapter` is the
// only `ClientProxy` holder behind it.
//
// `selectApplicablePrice` returns the single in-effect `PriceView` for the
// `(variantId, currency)` scope, or `null` when the variant is unknown/unpriced.
// The Add-to-Cart use case treats a `null` as a rejection (a cart line must carry
// a real price snapshot); the resolution policy (priority then recency) lives in
// the catalog microservice, not here. `amountMinor` is integer minor units
// (cents), copied straight into the cart line's `unitPriceSnapshotMinor`.
export interface ICartCatalogGatewayPort {
  selectApplicablePrice(
    variantId: number,
    currency: string,
    correlationId?: string,
  ): Promise<PriceView | null>;
}
