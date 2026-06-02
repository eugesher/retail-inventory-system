import {
  CatalogDomainException,
  Product,
  ProductArchivedEvent,
  ProductPublishedEvent,
  ProductStatusEnum,
  ProductVariant,
} from '..';

const makeVariant = (id: number | null, sku = `SKU-${id ?? 'new'}`): ProductVariant =>
  new ProductVariant({
    id,
    productId: 1,
    sku,
    optionValues: { color: 'red' },
  });

const makeProduct = (status: ProductStatusEnum, variants: ProductVariant[] = []): Product =>
  Product.reconstitute({
    id: 1,
    name: 'Test Shirt',
    slug: 'test-shirt',
    status,
    variants,
  });

describe('Product lifecycle', () => {
  describe('create', () => {
    it('creates a DRAFT product with no variants and records no event', () => {
      const product = Product.create({ name: 'Shirt', slug: 'shirt' });

      expect(product.status).toBe(ProductStatusEnum.DRAFT);
      expect(product.variants).toHaveLength(0);
      expect(product.pullDomainEvents()).toHaveLength(0);
    });

    it('rejects an empty name', () => {
      expect(() => Product.create({ name: '   ', slug: 'shirt' })).toThrow(CatalogDomainException);
    });

    it('rejects an empty slug', () => {
      expect(() => Product.create({ name: 'Shirt', slug: '' })).toThrow(CatalogDomainException);
    });
  });

  describe('publish (draft → active)', () => {
    it('transitions a draft product with at least one variant to active', () => {
      const product = makeProduct(ProductStatusEnum.DRAFT, [makeVariant(10)]);

      product.publish();

      expect(product.status).toBe(ProductStatusEnum.ACTIVE);
    });

    it('records ProductPublishedEvent carrying the slug and the concrete variantIds', () => {
      const product = makeProduct(ProductStatusEnum.DRAFT, [makeVariant(10), makeVariant(11)]);

      product.publish();

      const events = product.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(ProductPublishedEvent);
      const event = events[0] as ProductPublishedEvent;
      expect(event.productId).toBe(1);
      expect(event.slug).toBe('test-shirt');
      expect(event.variantIds).toEqual([10, 11]);
    });

    it('rejects publish() on a product with zero variants and leaves it draft', () => {
      const product = makeProduct(ProductStatusEnum.DRAFT, []);

      expect(() => product.publish()).toThrow(/at least one variant/);
      expect(product.status).toBe(ProductStatusEnum.DRAFT);
      expect(product.pullDomainEvents()).toHaveLength(0);
    });

    it('rejects publish() on an already-active product (non-draft)', () => {
      const product = makeProduct(ProductStatusEnum.ACTIVE, [makeVariant(10)]);

      expect(() => product.publish()).toThrow(CatalogDomainException);
    });

    it('rejects publish() on an archived product (non-draft)', () => {
      const product = makeProduct(ProductStatusEnum.ARCHIVED, [makeVariant(10)]);

      expect(() => product.publish()).toThrow(CatalogDomainException);
    });
  });

  describe('archive (active → archived)', () => {
    it('transitions an active product to archived and records ProductArchivedEvent', () => {
      const product = makeProduct(ProductStatusEnum.ACTIVE, [makeVariant(10)]);

      product.archive();

      expect(product.status).toBe(ProductStatusEnum.ARCHIVED);
      const events = product.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(ProductArchivedEvent);
      expect((events[0] as ProductArchivedEvent).productId).toBe(1);
    });

    it('rejects archive() on a draft product (non-active)', () => {
      const product = makeProduct(ProductStatusEnum.DRAFT, [makeVariant(10)]);

      expect(() => product.archive()).toThrow(CatalogDomainException);
    });

    it('rejects archive() on an already-archived product (terminal)', () => {
      const product = makeProduct(ProductStatusEnum.ARCHIVED, [makeVariant(10)]);

      expect(() => product.archive()).toThrow(CatalogDomainException);
    });
  });

  describe('full lifecycle', () => {
    it('walks draft → active → archived', () => {
      const product = makeProduct(ProductStatusEnum.DRAFT, [makeVariant(10)]);

      product.publish();
      expect(product.status).toBe(ProductStatusEnum.ACTIVE);

      product.archive();
      expect(product.status).toBe(ProductStatusEnum.ARCHIVED);
    });
  });

  // NOTE: `slug` global uniqueness is a repository-level guarantee — the domain
  // cannot see other aggregates. That invariant is asserted in the
  // register-product use-case spec (later work) against a repository test
  // double, not here.
});
