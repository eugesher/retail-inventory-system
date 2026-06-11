import {
  ICatalogProductArchivedEvent,
  ICatalogProductPublishedEvent,
  ICatalogVariantCreatedEvent,
  MediaOwnerTypeEnum,
} from '@retail-inventory-system/contracts';

import { Category, MediaAsset, Product, ProductVariant } from '../../../domain';
import {
  IActivePriceProbePort,
  ICatalogEventsPublisherPort,
  ICatalogListActiveQuery,
  ICatalogListByCategoryQuery,
  ICatalogRepositoryPort,
  ICategoryListAllOptions,
  ICategoryRepositoryPort,
  ICategorySubtreeOptions,
  IMediaAssetRepositoryPort,
  IMediaListByOwnerOptions,
  IProductPage,
} from '../../ports';

// Jest-free so the production build (which `tsconfig.app.json` excludes
// `*.spec.ts` but not `test-doubles.ts`) stays clean.

// In-memory catalog repository. `save` mimics the TypeORM repository's
// post-commit re-read: it assigns concrete ids to the product and every variant
// and returns a reconstituted aggregate, so the use case can read the concrete
// `variantId` back (ADR-025). `slugTaken` / `skuTaken` flip the uniqueness
// pre-checks the write use cases run.
export class InMemoryCatalogRepository implements ICatalogRepositoryPort {
  public readonly saved: Product[] = [];
  public slugTaken = false;
  public skuTaken = false;
  // Stands in for the shared `product_categories` table the real adapter reads
  // via the membership subselect — `categoryId → product ids`. The browse spec
  // seeds it with `attachProductToCategory`. `listByCategoryCalls` records each
  // resolved id set the use case asked for (so a spec can assert
  // `includeDescendants` expanded the scope to the subtree ids).
  public readonly categoryMembership = new Map<number, Set<number>>();
  public readonly listByCategoryCalls: number[][] = [];

  private readonly store = new Map<number, Product>();
  private nextProductId = 100;
  private nextVariantId = 5000;

  public seed(product: Product): void {
    if (product.id === null) {
      throw new Error('InMemoryCatalogRepository.seed: aggregate must be persisted (id !== null)');
    }
    this.store.set(product.id, product);
  }

  public existsBySlug(slug: string): Promise<boolean> {
    if (this.slugTaken) return Promise.resolve(true);
    for (const product of this.store.values()) {
      if (product.slug === slug) return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  public existsBySku(sku: string): Promise<boolean> {
    if (this.skuTaken) return Promise.resolve(true);
    for (const product of this.store.values()) {
      if (product.variants.some((variant) => variant.sku === sku)) return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  public save(product: Product): Promise<Product> {
    const id = product.id ?? this.nextProductId++;
    const variants = product.variants.map(
      (variant) =>
        new ProductVariant({
          id: variant.id ?? this.nextVariantId++,
          productId: id,
          sku: variant.sku,
          gtin: variant.gtin,
          optionValues: variant.optionValues,
          weightG: variant.weightG,
          dimensionsMm: variant.dimensionsMm,
          status: variant.status,
        }),
    );
    const persisted = Product.reconstitute({
      id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      status: product.status,
      variants,
    });
    this.store.set(id, persisted);
    this.saved.push(persisted);
    return Promise.resolve(persisted);
  }

  public findById(id: number): Promise<Product | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  public findBySlug(slug: string): Promise<Product | null> {
    for (const product of this.store.values()) {
      if (product.slug === slug) return Promise.resolve(product);
    }
    return Promise.resolve(null);
  }

  public findVariantById(variantId: number): Promise<ProductVariant | null> {
    for (const product of this.store.values()) {
      const variant = product.variants.find((candidate) => candidate.id === variantId);
      if (variant) return Promise.resolve(variant);
    }
    return Promise.resolve(null);
  }

  public listActive(query: ICatalogListActiveQuery): Promise<IProductPage> {
    const { page, size, search } = query;

    let matched = [...this.store.values()].filter((product) => product.isActive());
    if (search) {
      const needle = search.toLowerCase();
      matched = matched.filter(
        (product) =>
          product.name.toLowerCase().includes(needle) ||
          product.slug.toLowerCase().includes(needle),
      );
    }
    // Newest first — mirror the real adapter's `ORDER BY Product.id DESC`.
    matched.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));

    const total = matched.length;
    const start = (page - 1) * size;
    const items = matched.slice(start, start + size);
    return Promise.resolve({ items, total, page, size });
  }

  // Test seam: associate a (seeded) product with a category id, mirroring a
  // `product_categories` row.
  public attachProductToCategory(productId: number, categoryId: number): void {
    const members = this.categoryMembership.get(categoryId) ?? new Set<number>();
    members.add(productId);
    this.categoryMembership.set(categoryId, members);
  }

  public listActiveByCategoryIds(query: ICatalogListByCategoryQuery): Promise<IProductPage> {
    const { categoryIds, page, size } = query;
    this.listByCategoryCalls.push([...categoryIds]);

    // Union the members of every requested category, dedup (a product in two of
    // the ids appears once — the real adapter's implicit DISTINCT), keep only
    // active products, newest-first by id.
    const productIds = new Set<number>();
    for (const categoryId of categoryIds) {
      for (const productId of this.categoryMembership.get(categoryId) ?? []) {
        productIds.add(productId);
      }
    }

    const matched = [...productIds]
      .map((id) => this.store.get(id))
      .filter((product): product is Product => product !== undefined)
      .filter((product) => product.isActive())
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0));

    const total = matched.length;
    const start = (page - 1) * size;
    const items = matched.slice(start, start + size);
    return Promise.resolve({ items, total, page, size });
  }
}

// In-memory active-price probe. By default every variant is treated as priced
// (empty `unpriced` set), so the happy publish path proceeds. Add a variant id to
// `unpriced` to simulate a variant with no in-effect price; the probe then
// reports it as missing — mirroring the real adapter's "diff requested ids
// against the priced set" semantics. `calls` records each invocation so a spec
// can assert the probe received the default currency and the right variant ids.
export class InMemoryActivePriceProbe implements IActivePriceProbePort {
  public readonly unpriced = new Set<number>();
  public readonly calls: { variantIds: number[]; currency: string }[] = [];

  public findVariantsMissingActivePrice(variantIds: number[], currency: string): Promise<number[]> {
    this.calls.push({ variantIds, currency });
    return Promise.resolve(variantIds.filter((id) => this.unpriced.has(id)));
  }
}

export class InMemoryCatalogEventsPublisher implements ICatalogEventsPublisherPort {
  public readonly published: { event: ICatalogVariantCreatedEvent; correlationId?: string }[] = [];
  public readonly productPublished: {
    event: ICatalogProductPublishedEvent;
    correlationId?: string;
  }[] = [];
  public readonly productArchived: {
    event: ICatalogProductArchivedEvent;
    correlationId?: string;
  }[] = [];

  public publishVariantCreated(
    event: ICatalogVariantCreatedEvent,
    correlationId?: string,
  ): Promise<void> {
    this.published.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishProductPublished(
    event: ICatalogProductPublishedEvent,
    correlationId?: string,
  ): Promise<void> {
    this.productPublished.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishProductArchived(
    event: ICatalogProductArchivedEvent,
    correlationId?: string,
  ): Promise<void> {
    this.productArchived.push({ event, correlationId });
    return Promise.resolve();
  }
}

// In-memory Category repository. `save` mimics the TypeORM repository's
// post-commit re-read: it assigns a concrete id and returns a reconstituted
// aggregate, so the create use case reads the concrete `categoryId` back. `seed`
// preloads a persisted category (e.g. a parent or a reparent target). `existsBySlug`
// honours an explicit `slugTaken` override (so a spec can force the duplicate-slug
// path) on top of the seeded rows. `reparentSubtree` RECORDS its arguments in
// `reparentCalls` (the use-case spec asserts it received the recomputed aggregate +
// the captured `oldPath`) and returns the configurable `reparentReturnCount` — the
// single-transaction rebase itself is the real repository's concern, locked by its
// own spec, so the double only needs to surface the count.
export class InMemoryCategoryRepository implements ICategoryRepositoryPort {
  public slugTaken = false;
  public reparentReturnCount = 0;
  public readonly saved: Category[] = [];
  public readonly reparentCalls: { category: Category; oldPath: string }[] = [];
  // Stands in for the `product_categories` join table — `productId → category
  // ids`. The Set makes `attach` naturally idempotent (re-adding a member is a
  // no-op, the `INSERT IGNORE` semantics) and `detach` of an absent member a
  // silent no-op (the `DELETE` semantics).
  public readonly productCategories = new Map<number, Set<number>>();

  private readonly store = new Map<number, Category>();
  private nextCategoryId = 100;

  public seed(category: Category): void {
    if (category.id === null) {
      throw new Error('InMemoryCategoryRepository.seed: aggregate must be persisted (id !== null)');
    }
    this.store.set(category.id, category);
  }

  public save(category: Category): Promise<Category> {
    const id = category.id ?? this.nextCategoryId++;
    const persisted = Category.reconstitute({
      id,
      name: category.name,
      slug: category.slug,
      parentId: category.parentId,
      path: category.path,
      sortOrder: category.sortOrder,
      status: category.status,
    });
    this.store.set(id, persisted);
    this.saved.push(persisted);
    return Promise.resolve(persisted);
  }

  public findById(id: number): Promise<Category | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  public findBySlug(slug: string): Promise<Category | null> {
    for (const category of this.store.values()) {
      if (category.slug === slug) return Promise.resolve(category);
    }
    return Promise.resolve(null);
  }

  public existsBySlug(slug: string): Promise<boolean> {
    if (this.slugTaken) return Promise.resolve(true);
    for (const category of this.store.values()) {
      if (category.slug === slug) return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  public listAll(opts: ICategoryListAllOptions): Promise<Category[]> {
    let matched = [...this.store.values()];
    if (opts.rootOnly) {
      matched = matched.filter((category) => category.parentId === null);
    }
    if (opts.activeOnly) {
      matched = matched.filter((category) => category.isActive());
    }
    // `sortOrder ASC, name ASC` — mirrors the real adapter's ORDER BY for the flat
    // list read (the store-front navigation order).
    matched.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return Promise.resolve(matched);
  }

  public listSubtree(pathPrefix: string, opts?: ICategorySubtreeOptions): Promise<Category[]> {
    let matched = [...this.store.values()].filter(
      (category) => category.path === pathPrefix || category.path.startsWith(`${pathPrefix}/`),
    );
    if (opts?.activeOnly) {
      matched = matched.filter((category) => category.isActive());
    }
    matched.sort((a, b) => a.path.localeCompare(b.path));
    return Promise.resolve(matched);
  }

  public reparentSubtree(category: Category, oldPath: string): Promise<number> {
    this.reparentCalls.push({ category, oldPath });
    if (category.id !== null) {
      this.store.set(category.id, category);
    }
    return Promise.resolve(this.reparentReturnCount);
  }

  public attachProductCategories(productId: number, categoryIds: number[]): Promise<void> {
    const members = this.productCategories.get(productId) ?? new Set<number>();
    for (const categoryId of categoryIds) {
      members.add(categoryId);
    }
    this.productCategories.set(productId, members);
    return Promise.resolve();
  }

  public detachProductCategories(productId: number, categoryIds: number[]): Promise<void> {
    const members = this.productCategories.get(productId);
    if (members) {
      for (const categoryId of categoryIds) {
        members.delete(categoryId);
      }
    }
    return Promise.resolve();
  }

  public listCategoriesForProduct(productId: number): Promise<Category[]> {
    const members = this.productCategories.get(productId) ?? new Set<number>();
    const categories = [...members]
      .map((id) => this.store.get(id))
      .filter((category): category is Category => category !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path));
    return Promise.resolve(categories);
  }
}

// In-memory MediaAsset repository. `save` mimics the TypeORM repository's
// post-commit re-read: it assigns a concrete id and returns a reconstituted
// aggregate, so the attach use case reads the concrete `mediaId` back. `seed`
// preloads a persisted asset. `maxSortOrder` mirrors the real adapter's
// `MAX(sort_order)` across ALL rows (archived included), so the attach defaulting
// spec can assert a detached row's slot is still counted into the max.
// `reorder` RECORDS its arguments in `reorderCalls` (the reorder spec asserts it
// is called exactly once on a valid permutation and never on a mismatch) and
// re-slots the affected rows by array index before returning the refreshed active
// list — the single-transaction mechanics are the real repository's concern,
// locked by its own spec.
export class InMemoryMediaAssetRepository implements IMediaAssetRepositoryPort {
  public readonly saved: MediaAsset[] = [];
  public readonly reorderCalls: {
    ownerType: MediaOwnerTypeEnum;
    ownerId: number;
    orderedIds: number[];
  }[] = [];

  private readonly store = new Map<number, MediaAsset>();
  private nextMediaId = 1000;

  public seed(media: MediaAsset): void {
    if (media.id === null) {
      throw new Error(
        'InMemoryMediaAssetRepository.seed: aggregate must be persisted (id !== null)',
      );
    }
    this.store.set(media.id, media);
  }

  public save(media: MediaAsset): Promise<MediaAsset> {
    const id = media.id ?? this.nextMediaId++;
    const persisted = MediaAsset.reconstitute({
      id,
      ownerType: media.ownerType,
      ownerId: media.ownerId,
      uri: media.uri,
      type: media.type,
      altText: media.altText,
      sortOrder: media.sortOrder,
      status: media.status,
    });
    this.store.set(id, persisted);
    this.saved.push(persisted);
    return Promise.resolve(persisted);
  }

  public findById(id: number): Promise<MediaAsset | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  public listByOwner(
    ownerType: MediaOwnerTypeEnum,
    ownerId: number,
    opts?: IMediaListByOwnerOptions,
  ): Promise<MediaAsset[]> {
    let matched = [...this.store.values()].filter(
      (media) => media.ownerType === ownerType && media.ownerId === ownerId,
    );
    if (opts?.activeOnly) {
      matched = matched.filter((media) => media.isActive());
    }
    // `sortOrder ASC, id ASC` — mirrors the real adapter's ORDER BY.
    matched.sort((a, b) => a.sortOrder - b.sortOrder || (a.id ?? 0) - (b.id ?? 0));
    return Promise.resolve(matched);
  }

  public maxSortOrder(ownerType: MediaOwnerTypeEnum, ownerId: number): Promise<number | null> {
    const slots = [...this.store.values()]
      .filter((media) => media.ownerType === ownerType && media.ownerId === ownerId)
      .map((media) => media.sortOrder);
    return Promise.resolve(slots.length === 0 ? null : Math.max(...slots));
  }

  public reorder(
    ownerType: MediaOwnerTypeEnum,
    ownerId: number,
    orderedIds: number[],
  ): Promise<MediaAsset[]> {
    this.reorderCalls.push({ ownerType, ownerId, orderedIds: [...orderedIds] });
    orderedIds.forEach((id, index) => {
      this.store.get(id)?.changeSortOrder(index);
    });
    return this.listByOwner(ownerType, ownerId, { activeOnly: true });
  }

  // Mirrors the real adapter's owner-pair tuple IN-list existence probe: true
  // when ANY of the pairs has an active asset. Used by the publish soft-warning
  // spec — empty store / archived-only owners report `false`, an active asset on
  // the product OR any variant reports `true`.
  public hasActiveForOwners(
    owners: { ownerType: MediaOwnerTypeEnum; ownerId: number }[],
  ): Promise<boolean> {
    const has = owners.some((owner) =>
      [...this.store.values()].some(
        (media) =>
          media.ownerType === owner.ownerType &&
          media.ownerId === owner.ownerId &&
          media.isActive(),
      ),
    );
    return Promise.resolve(has);
  }
}
