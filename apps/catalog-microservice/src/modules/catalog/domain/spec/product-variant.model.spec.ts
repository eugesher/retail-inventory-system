import {
  CatalogDomainException,
  Product,
  ProductStatusEnum,
  ProductVariant,
  ProductVariantStatusEnum,
  VariantCreatedEvent,
} from '..';

const baseProps = {
  id: null,
  productId: 1,
  sku: 'SKU-1',
  optionValues: { color: 'red' },
};

describe('ProductVariant invariants', () => {
  it('constructs an ACTIVE variant from valid props', () => {
    const variant = new ProductVariant({ ...baseProps });

    expect(variant.status).toBe(ProductVariantStatusEnum.ACTIVE);
    expect(variant.isActive()).toBe(true);
    expect(variant.optionValues).toEqual({ color: 'red' });
  });

  it('rejects an empty sku', () => {
    expect(() => new ProductVariant({ ...baseProps, sku: '   ' })).toThrow(CatalogDomainException);
  });

  it('rejects an empty optionValues map', () => {
    expect(() => new ProductVariant({ ...baseProps, optionValues: {} })).toThrow(/non-empty map/);
  });

  it('rejects an optionValues entry with an empty value', () => {
    expect(() => new ProductVariant({ ...baseProps, optionValues: { color: '' } })).toThrow(
      CatalogDomainException,
    );
  });

  it('rejects a negative weightG', () => {
    expect(() => new ProductVariant({ ...baseProps, weightG: -1 })).toThrow(CatalogDomainException);
  });

  it('rejects a non-integer weightG', () => {
    expect(() => new ProductVariant({ ...baseProps, weightG: 1.5 })).toThrow(
      CatalogDomainException,
    );
  });

  it('accepts a zero weightG (non-negative)', () => {
    expect(() => new ProductVariant({ ...baseProps, weightG: 0 })).not.toThrow();
  });

  it('rejects negative dimensions', () => {
    expect(() => new ProductVariant({ ...baseProps, dimensionsMm: { l: -1, w: 2, h: 3 } })).toThrow(
      CatalogDomainException,
    );
  });

  it('round-trips optional gtin and dimensions', () => {
    const variant = new ProductVariant({
      ...baseProps,
      gtin: '0123456789012',
      dimensionsMm: { l: 100, w: 50, h: 20 },
    });

    expect(variant.gtin).toBe('0123456789012');
    expect(variant.dimensionsMm).toEqual({ l: 100, w: 50, h: 20 });
  });
});

describe('Product.addVariant', () => {
  it('adds a child variant through the root and records VariantCreatedEvent', () => {
    const product = Product.reconstitute({
      id: 1,
      name: 'Shirt',
      slug: 'shirt',
      status: ProductStatusEnum.DRAFT,
      variants: [],
    });

    const variant = product.addVariant({ sku: 'SKU-NEW', optionValues: { size: 'M' } });

    expect(product.variants).toHaveLength(1);
    expect(variant.status).toBe(ProductVariantStatusEnum.ACTIVE);

    const events = product.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(VariantCreatedEvent);
    const event = events[0] as VariantCreatedEvent;
    expect(event.productId).toBe(1);
    expect(event.sku).toBe('SKU-NEW');
  });
});
