import { VariantTaxHeaderView } from '@retail-inventory-system/contracts';

import { Price, TaxCategory } from '../../domain';

export const PRICING_REPOSITORY = Symbol('PRICING_REPOSITORY');

// The repository seam for the pricing write and read paths. It returns domain
// types only — no TypeORM entity, `Repository`, or `EntityManager` type leaks
// here (ADR-017 forbids `typeorm` in `application/ports`). The TypeORM details
// live entirely in `PricingTypeormRepository`.
//
// Global `TaxCategory.code` uniqueness and variant existence are repository-level
// invariants the domain cannot see (ADR-025): the UNIQUE / FK constraints in the
// schema are the hard guard, and these query methods give the write use cases a
// clean pre-check so a clash raises a typed domain error instead of a raw driver
// exception.
export interface IPricingRepositoryPort {
  // The single open (`validTo IS NULL`) price for a `(variantId, currency)`
  // scope, or null. At most one exists by invariant (ADR-026); the write use
  // case closes it before appending a successor.
  findOpenPrice(variantId: number, currency: string): Promise<Price | null>;

  // Atomic append. If `predecessorToClose` is non-null, set its `valid_to` in
  // the SAME transaction as the insert of `newPrice` (the caller passes the
  // already-closed predecessor — see `Price.close`), then re-read and return the
  // inserted row with its concrete id. The DB-level open-scope UNIQUE index is
  // the backstop that prevents two open rows under a race.
  appendPrice(newPrice: Price, predecessorToClose: Price | null): Promise<Price>;

  // All rows whose `[validFrom, validTo)` interval contains `asOf` for the
  // `(variantId, currency)` scope. A COARSE candidate filter only — the
  // priority/recency resolution (sort + tiebreak + pick) lives in the use case.
  findInEffect(variantId: number, currency: string, asOf: Date): Promise<Price[]>;

  // Inserts a new tax category. The caller pre-checks `findTaxCategoryByCode`
  // first so a duplicate raises a typed `TAX_CATEGORY_CODE_TAKEN` rather than a
  // raw UNIQUE-violation driver error.
  createTaxCategory(taxCategory: TaxCategory): Promise<TaxCategory>;
  listTaxCategories(): Promise<TaxCategory[]>;
  findTaxCategoryByCode(code: string): Promise<TaxCategory | null>;

  // Writes the `product_variant.tax_category_id` FK for a variant. The column is
  // a pricing-introduced column on a table the catalog module owns; pricing owns
  // its semantics and reaches it with a **parameterized query**, never the catalog
  // `ProductVariantEntity` (a cross-module infrastructure import the boundaries
  // lint forbids — the opaque `variantId` + the FK are the only coupling, ADR-026
  // §5). The caller resolves the code → id and checks variant existence first.
  attachTaxCategoryToVariant(variantId: number, taxCategoryId: number): Promise<void>;

  // The minimal tax projection of a variant — its identity plus its current tax
  // category (joined `LEFT` so an unclassified variant returns `null` columns).
  // `null` (the whole result) means the variant does not exist. Also a
  // parameterized query against `product_variant` / `tax_category`, never a
  // catalog entity import. Used both as the attach pre-check (variant existence)
  // and to build the "updated variant header" the attach command returns — its
  // shape *is* the `VariantTaxHeaderView` the command resolves to, so the use case
  // returns the row straight through.
  findVariantTaxHeader(variantId: number): Promise<VariantTaxHeaderView | null>;
}
