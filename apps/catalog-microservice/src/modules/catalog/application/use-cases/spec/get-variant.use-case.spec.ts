import { PinoLogger } from 'nestjs-pino';

import { IGetVariantQuery } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  CatalogDomainException,
  CatalogErrorCodeEnum,
  Product,
  ProductStatusEnum,
  ProductVariant,
  ProductVariantStatusEnum,
} from '../../../domain';
import { GetVariantUseCase } from '../get-variant.use-case';
import { InMemoryCatalogRepository } from './test-doubles';

describe('GetVariantUseCase', () => {
  let repository: InMemoryCatalogRepository;
  let logger: PinoLoggerMock;
  let useCase: GetVariantUseCase;

  beforeEach(() => {
    repository = new InMemoryCatalogRepository();
    logger = makePinoLoggerMock();
    useCase = new GetVariantUseCase(repository, logger as unknown as PinoLogger);
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

  const query = (variantId: number): IGetVariantQuery => ({ variantId, correlationId: 'corr-1' });

  it('returns the variant with its parent product header', async () => {
    seedProduct(100, 'aeron-chair', ProductStatusEnum.ACTIVE, [
      variant(5001, 100, ProductVariantStatusEnum.ACTIVE),
    ]);

    const view = await useCase.execute(query(5001));

    expect(view.id).toBe(5001);
    expect(view.productId).toBe(100);
    expect(view.sku).toBe('SKU-5001');
    expect(view.product.id).toBe(100);
    expect(view.product.slug).toBe('aeron-chair');
    expect(view.product.status).toBe(ProductStatusEnum.ACTIVE);
  });

  it('still resolves an archived variant on an archived product (no dangling references)', async () => {
    seedProduct(102, 'mirra-chair', ProductStatusEnum.ARCHIVED, [
      variant(5004, 102, ProductVariantStatusEnum.ARCHIVED),
    ]);

    const view = await useCase.execute(query(5004));

    expect(view.id).toBe(5004);
    expect(view.status).toBe(ProductVariantStatusEnum.ARCHIVED);
    expect(view.product.id).toBe(102);
    expect(view.product.status).toBe(ProductStatusEnum.ARCHIVED);
  });

  it('rejects with VARIANT_NOT_FOUND for an unknown variant id', async () => {
    await expect(useCase.execute(query(9999))).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.VARIANT_NOT_FOUND,
    });
    await expect(useCase.execute(query(9999))).rejects.toBeInstanceOf(CatalogDomainException);
  });
});
