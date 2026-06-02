import { PinoLogger } from 'nestjs-pino';

import { IGetProductBySlugQuery } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  CatalogDomainException,
  CatalogErrorCodeEnum,
  Product,
  ProductStatusEnum,
  ProductVariant,
  ProductVariantStatusEnum,
} from '../../../domain';
import { GetProductBySlugUseCase } from '../get-product-by-slug.use-case';
import { InMemoryCatalogRepository } from './test-doubles';

describe('GetProductBySlugUseCase', () => {
  let repository: InMemoryCatalogRepository;
  let logger: PinoLoggerMock;
  let useCase: GetProductBySlugUseCase;

  beforeEach(() => {
    repository = new InMemoryCatalogRepository();
    logger = makePinoLoggerMock();
    useCase = new GetProductBySlugUseCase(repository, logger as unknown as PinoLogger);
  });

  const variant = (
    id: number,
    productId: number,
    status: ProductVariantStatusEnum,
  ): ProductVariant =>
    new ProductVariant({
      id,
      productId,
      sku: `SKU-${id}`,
      optionValues: { size: 'M' },
      status,
    });

  const seedProduct = (
    id: number,
    slug: string,
    status: ProductStatusEnum,
    variants: ProductVariant[],
  ): void => {
    repository.seed(Product.reconstitute({ id, name: 'Aeron Chair', slug, status, variants }));
  };

  const query = (slug: string): IGetProductBySlugQuery => ({ slug, correlationId: 'corr-1' });

  it('returns an active product with its active variants', async () => {
    seedProduct(100, 'aeron-chair', ProductStatusEnum.ACTIVE, [
      variant(5001, 100, ProductVariantStatusEnum.ACTIVE),
      variant(5002, 100, ProductVariantStatusEnum.ARCHIVED),
    ]);

    const view = await useCase.execute(query('aeron-chair'));

    expect(view.id).toBe(100);
    expect(view.slug).toBe('aeron-chair');
    expect(view.status).toBe(ProductStatusEnum.ACTIVE);
    expect(view.variants).toHaveLength(1); // archived variant filtered out
    expect(view.variants[0].id).toBe(5001);
  });

  it('still resolves an archived product by slug (resolvable regardless of status)', async () => {
    seedProduct(102, 'mirra-chair', ProductStatusEnum.ARCHIVED, [
      variant(5004, 102, ProductVariantStatusEnum.ACTIVE),
    ]);

    const view = await useCase.execute(query('mirra-chair'));

    expect(view.id).toBe(102);
    expect(view.status).toBe(ProductStatusEnum.ARCHIVED);
    expect(view.variants).toHaveLength(1);
  });

  it('rejects with PRODUCT_NOT_FOUND for an unknown slug', async () => {
    await expect(useCase.execute(query('nope'))).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
    });
    await expect(useCase.execute(query('nope'))).rejects.toBeInstanceOf(CatalogDomainException);
  });
});
