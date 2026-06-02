import {
  ICatalogProductArchivedEvent,
  ICatalogProductPublishedEvent,
  ICatalogVariantCreatedEvent,
} from '@retail-inventory-system/contracts';

import { Product, ProductVariant } from '../../../domain';
import {
  ICatalogEventsPublisherPort,
  ICatalogListActiveQuery,
  ICatalogRepositoryPort,
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
