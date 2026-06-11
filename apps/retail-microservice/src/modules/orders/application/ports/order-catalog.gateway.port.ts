import { PriceView, VariantWithProductView } from '@retail-inventory-system/contracts';

export const ORDER_CATALOG_GATEWAY = Symbol('ORDER_CATALOG_GATEWAY');

// The orders context's outbound seam onto the catalog microservice, used by Place
// Order to snapshot each line from the catalog at write-time (ADR-025 / ADR-026).
// Domain/contract types only — no `@nestjs/microservices` here (ADR-009); the
// concrete `OrderCatalogRabbitmqAdapter` is the only `ClientProxy` holder.
//
// - `getVariant` resolves a variant + its parent product header (`sku`,
//   `product.name`, `optionValues`) for the `OrderLine.sku` / `nameSnapshot`
//   snapshot. It **rejects** if the variant is unresolvable (the catalog RPC errors
//   on an unknown id) — a placed line must name a real variant.
// - `selectApplicablePrice` resolves the single applicable price for
//   `(variantId, currency)` as of now, or `null` when none is in effect — the place
//   use case rejects a `null` (`ORDER_LINE_NO_PRICE`) rather than snapshotting a
//   zero-price line. `amountMinor` is integer minor units (ADR-026).
export interface IOrderCatalogGatewayPort {
  getVariant(variantId: number, correlationId?: string): Promise<VariantWithProductView>;
  selectApplicablePrice(
    variantId: number,
    currency: string,
    correlationId?: string,
  ): Promise<PriceView | null>;
}
