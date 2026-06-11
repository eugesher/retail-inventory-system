import {
  ICatalogProductArchivedEvent,
  ICatalogProductPublishedEvent,
  ICatalogVariantCreatedEvent,
} from '@retail-inventory-system/contracts';

import { Category, Product, ProductVariant } from '../../../domain';
import {
  IActivePriceProbePort,
  ICatalogEventsPublisherPort,
  ICatalogListActiveQuery,
  ICatalogRepositoryPort,
  ICategoryListAllOptions,
  ICategoryRepositoryPort,
  ICategorySubtreeOptions,
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
    matched.sort((a, b) => a.path.localeCompare(b.path));
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
}
