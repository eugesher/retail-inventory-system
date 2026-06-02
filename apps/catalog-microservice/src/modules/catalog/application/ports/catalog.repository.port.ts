import { Product, ProductVariant } from '../../domain';

export const CATALOG_REPOSITORY = Symbol('CATALOG_REPOSITORY');

// Query shape for the active-catalog read path. Declared locally rather than
// imported from `libs/common` because the boundaries lint keeps the
// application-port layer to domain + ddd + contracts only (ADR-017) — the port
// is a pure TypeScript contract with no framework or cross-lib utility imports.
export interface ICatalogListActiveQuery {
  page: number;
  size: number;
  search?: string;
}

export interface IProductPage {
  items: Product[];
  total: number;
  page: number;
  size: number;
}

// The repository seam for the catalog write and read paths. It returns domain
// types only — no TypeORM entity, `Repository`, or `EntityManager` type leaks
// here (ADR-017 forbids `typeorm` in `application/ports`). The TypeORM details
// live entirely in `CatalogTypeormRepository`.
//
// `slug`/`sku` global uniqueness is a repository-level invariant the domain
// cannot see (ADR-025): the UNIQUE constraints in the schema are the guard, and
// `existsBySlug`/`existsBySku` give the write use cases a clean pre-check so a
// duplicate raises a typed domain error instead of a raw driver exception.
export interface ICatalogRepositoryPort {
  // Inserts or updates the product root together with its variants.
  save(product: Product): Promise<Product>;
  findById(id: number): Promise<Product | null>;
  findBySlug(slug: string): Promise<Product | null>;
  existsBySlug(slug: string): Promise<boolean>;
  existsBySku(sku: string): Promise<boolean>;
  // Read helper for the top-level variant addressing (the read model) — a
  // variant is addressable on its own on the read path even though it is only
  // mutated through the `Product` root on the write path.
  findVariantById(variantId: number): Promise<ProductVariant | null>;
  // Paginated list of active products (the published catalogue), newest first,
  // optionally filtered by a name/slug substring search.
  listActive(query: ICatalogListActiveQuery): Promise<IProductPage>;
}
