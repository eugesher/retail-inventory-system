// The polymorphic owner discriminator for a `MediaAsset`. A media row hangs off
// EITHER a product or a single product variant — `ownerType` names which table
// the opaque `ownerId` points into. There is NO foreign key on the polymorphic
// owner (an FK cannot target two tables), so the value here is the only thing
// that says how to interpret `ownerId`; the use case re-checks owner existence
// against the right table (ADR-029 §4).
//
// This is a WIRE CONTRACT: it rides every `catalog.media.*` command payload and
// surfaces on `MediaAssetView`, so it lives in `libs/contracts` — unlike the
// lifecycle `MediaAssetStatusEnum`, which is an internal domain concept and stays
// in the catalog `domain/` (ADR-025 §7).
export enum MediaOwnerTypeEnum {
  PRODUCT = 'product',
  PRODUCT_VARIANT = 'product-variant',
}
