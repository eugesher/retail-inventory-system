import { Category } from '../../domain';

export const CATEGORY_REPOSITORY = Symbol('CATEGORY_REPOSITORY');

// Options for the flat list read. `rootOnly` keeps only top-level categories
// (`parentId IS NULL`); `activeOnly` keeps only `status = 'active'` rows. Both
// default off (every category, every status) when omitted.
export interface ICategoryListAllOptions {
  rootOnly?: boolean;
  activeOnly?: boolean;
}

// Options for the subtree read. `activeOnly` filters `status = 'active'`.
export interface ICategorySubtreeOptions {
  activeOnly?: boolean;
}

// The repository seam for the Category aggregate. It is a SEPARATE port from
// `CATALOG_REPOSITORY` (one port per aggregate seam — the `ACTIVE_PRICE_PROBE`
// precedent; ADR-029 §8), so `ICatalogRepositoryPort` does not grow into a
// module-wide grab-bag.
//
// It returns domain types only — no TypeORM entity, `Repository`, or
// `EntityManager` type leaks here (ADR-017 forbids `typeorm` in
// `application/ports`). The TypeORM details live entirely in
// `CategoryTypeormRepository`.
//
// `slug` global uniqueness is a repository-level invariant the domain cannot see
// (ADR-025): the UNIQUE constraint in the schema is the guard, and `existsBySlug`
// gives the (later) create use case a clean pre-check so a duplicate raises a
// typed domain error instead of a raw driver exception.
export interface ICategoryRepositoryPort {
  // Inserts or updates one category row; re-reads for the concrete id.
  save(category: Category): Promise<Category>;
  findById(id: number): Promise<Category | null>;
  findBySlug(slug: string): Promise<Category | null>;
  existsBySlug(slug: string): Promise<boolean>;
  // Flat reads for list / tree assembly. The caller assembles the tree from the
  // flat rows (each row carries its `parentId` + `path`).
  listAll(opts: ICategoryListAllOptions): Promise<Category[]>;
  // Every category whose `path` IS `pathPrefix` or starts with `pathPrefix + '/'`
  // (self included) — the subtree read for tree assembly and descendant counts.
  listSubtree(pathPrefix: string, opts?: ICategorySubtreeOptions): Promise<Category[]>;
  // One-transaction reparent: UPDATEs the moved category row (its `parent_id` +
  // `path` are already recomputed on the passed aggregate via `reparentUnder`)
  // AND rebases every descendant path in a single bulk statement. `oldPath` is
  // the moved category's path BEFORE the recompute. Returns the number of
  // descendant rows rewritten (the reparent response surfaces it).
  reparentSubtree(category: Category, oldPath: string): Promise<number>;

  // --- product_categories N↔M membership (ADR-029 §3) -----------------------
  //
  // The membership lives in a BARE join table (`product_categories`, composite PK
  // `(product_id, category_id)`, no surrogate id, NO TypeORM entity). Neither
  // `Product` nor `Category` holds it in memory — it is a browse concern, so the
  // repository maintains it directly with parameterized SQL through the injected
  // manager (the `product_variant.tax_category_id` precedent, ADR-026 §5). Both
  // writes are IDEMPOTENT: `attach` is an `INSERT IGNORE` (re-attaching an
  // existing membership is a silent success) and `detach` a `DELETE` (detaching a
  // non-membership is a silent no-op), so a retried reclassify RPC is safe.

  // Attaches the product to every given category, ignoring already-present pairs.
  // A no-op when `categoryIds` is empty.
  attachProductCategories(productId: number, categoryIds: number[]): Promise<void>;
  // Detaches the product from every given category, ignoring absent pairs. A
  // no-op when `categoryIds` is empty.
  detachProductCategories(productId: number, categoryIds: number[]): Promise<void>;
  // Every category the product currently belongs to — the full post-operation
  // membership the reclassify response surfaces. Returns domain `Category`
  // aggregates (the join is resolved to the `category` rows), any status.
  listCategoriesForProduct(productId: number): Promise<Category[]>;
}
