import { PinoLogger } from 'nestjs-pino';

import { IListProductsQuery } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  Product,
  ProductStatusEnum,
  ProductVariant,
  ProductVariantStatusEnum,
} from '../../../domain';
import { ListProductsUseCase } from '../list-products.use-case';
import { InMemoryCatalogRepository } from './test-doubles';

describe('ListProductsUseCase', () => {
  let repository: InMemoryCatalogRepository;
  let logger: PinoLoggerMock;
  let useCase: ListProductsUseCase;

  beforeEach(() => {
    repository = new InMemoryCatalogRepository();
    logger = makePinoLoggerMock();
    useCase = new ListProductsUseCase(repository, logger as unknown as PinoLogger);
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
    name: string,
    slug: string,
    status: ProductStatusEnum,
    variants: ProductVariant[],
  ): void => {
    repository.seed(Product.reconstitute({ id, name, slug, status, variants }));
  };

  const query = (overrides: Partial<IListProductsQuery> = {}): IListProductsQuery => ({
    correlationId: 'corr-1',
    ...overrides,
  });

  it('returns only active products with their active variants', async () => {
    seedProduct(100, 'Aeron Chair', 'aeron-chair', ProductStatusEnum.ACTIVE, [
      variant(5001, 100, ProductVariantStatusEnum.ACTIVE),
      variant(5002, 100, ProductVariantStatusEnum.ARCHIVED),
    ]);
    seedProduct(101, 'Embody Chair', 'embody-chair', ProductStatusEnum.DRAFT, [
      variant(5003, 101, ProductVariantStatusEnum.ACTIVE),
    ]);
    seedProduct(102, 'Mirra Chair', 'mirra-chair', ProductStatusEnum.ARCHIVED, [
      variant(5004, 102, ProductVariantStatusEnum.ACTIVE),
    ]);

    const result = await useCase.execute(query());

    // Only the active product surfaces — draft and archived are hidden.
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(100);
    expect(result.items[0].status).toBe(ProductStatusEnum.ACTIVE);
    // Its archived variant is filtered out of the read view.
    expect(result.items[0].variants).toHaveLength(1);
    expect(result.items[0].variants[0].id).toBe(5001);
    expect(result.items[0].variants[0].status).toBe(ProductVariantStatusEnum.ACTIVE);
  });

  it('echoes the pagination shape (total / page / size)', async () => {
    for (let i = 0; i < 3; i++) {
      seedProduct(200 + i, `Product ${i}`, `product-${i}`, ProductStatusEnum.ACTIVE, [
        variant(6000 + i, 200 + i, ProductVariantStatusEnum.ACTIVE),
      ]);
    }

    const result = await useCase.execute(query({ page: 1, pageSize: 2 }));

    expect(result.total).toBe(3); // total matching, not the page slice
    expect(result.page).toBe(1);
    expect(result.size).toBe(2);
    expect(result.items).toHaveLength(2); // page slice honours pageSize
  });

  it('applies the default page/size when the query omits them', async () => {
    seedProduct(300, 'Only One', 'only-one', ProductStatusEnum.ACTIVE, [
      variant(7000, 300, ProductVariantStatusEnum.ACTIVE),
    ]);

    const result = await useCase.execute(query());

    expect(result.page).toBe(1);
    expect(result.size).toBe(20);
    expect(result.items).toHaveLength(1);
  });

  it('passes the search filter through to the repository', async () => {
    seedProduct(400, 'Aeron Chair', 'aeron-chair', ProductStatusEnum.ACTIVE, [
      variant(8000, 400, ProductVariantStatusEnum.ACTIVE),
    ]);
    seedProduct(401, 'Standing Desk', 'standing-desk', ProductStatusEnum.ACTIVE, [
      variant(8001, 401, ProductVariantStatusEnum.ACTIVE),
    ]);

    const result = await useCase.execute(query({ search: 'desk' }));

    expect(result.items).toHaveLength(1);
    expect(result.items[0].slug).toBe('standing-desk');
  });
});
