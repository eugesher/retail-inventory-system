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
}
