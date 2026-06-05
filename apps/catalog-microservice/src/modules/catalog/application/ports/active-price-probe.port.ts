// The catalog-side seam for the "a product needs ≥1 active Price to publish"
// precondition. Price lives in the colocated pricing module, which the catalog
// module MUST NOT import (cross-module infrastructure import — the boundaries
// lint's red line, ADR-017). So the publish use case asks this port — "of these
// variant ids, which have NO in-effect price?" — instead of reaching into
// pricing's domain/repository. The TypeORM adapter answers it with a
// parameterized read against the `price` table; the opaque `variantId` and that
// table are the only coupling (the symmetric mirror of how pricing writes the
// catalog-owned `product_variant.tax_category_id`, ADR-025 / ADR-026 §5).
export const ACTIVE_PRICE_PROBE = Symbol('ACTIVE_PRICE_PROBE');

export interface IActivePriceProbePort {
  // Of the given variant ids, which have NO in-effect Price in `currency` at now?
  // An empty result means every variant is priced — publish may proceed. An empty
  // input list is a no-op (returns `[]`): the domain owns the ≥1-variant rule, so
  // a variant-less product is rejected by `Product.publish()`, not by this probe.
  findVariantsMissingActivePrice(variantIds: number[], currency: string): Promise<number[]>;
}

// The currency the publish precondition resolves against — the value of the
// `DEFAULT_CURRENCY` env (Joi default `USD`), bound as a plain string in
// `catalog.module.ts` so the use case injects it without importing
// `@nestjs/config` (ADR-017 keeps the application layer framework-light). A
// product publishes only when every variant has an in-effect price in this
// currency.
export const CATALOG_DEFAULT_CURRENCY = Symbol('CATALOG_DEFAULT_CURRENCY');
