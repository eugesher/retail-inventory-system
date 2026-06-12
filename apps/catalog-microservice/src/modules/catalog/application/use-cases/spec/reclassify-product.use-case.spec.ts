import { PinoLogger } from 'nestjs-pino';

import { IReclassifyProductPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  CatalogDomainException,
  CatalogErrorCodeEnum,
  Category,
  CategoryStatusEnum,
  Product,
  ProductStatusEnum,
} from '../../../domain';
import { ReclassifyProductUseCase } from '../reclassify-product.use-case';
import { InMemoryCatalogRepository, InMemoryCategoryRepository } from './test-doubles';

// A persisted product (any status — reclassify is status-agnostic on the product).
const seedProduct = (id: number): Product =>
  Product.reconstitute({
    id,
    name: 'Classic Tee',
    slug: 'classic-tee',
    description: 'A tee',
    status: ProductStatusEnum.ACTIVE,
    variants: [],
  });

// A persisted category to seed the in-memory repo (the reclassify resolves it by
// slug). `create` always starts a fresh active root/child, so a seeded row uses
// `reconstitute` to pin a known id/path/status.
const seedCategory = (overrides: {
  id: number;
  slug: string;
  path: string;
  status?: CategoryStatusEnum;
}): Category =>
  Category.reconstitute({
    id: overrides.id,
    name: overrides.slug,
    slug: overrides.slug,
    parentId: null,
    path: overrides.path,
    sortOrder: 0,
    status: overrides.status ?? CategoryStatusEnum.ACTIVE,
  });

const PRODUCT_ID = 7;

describe('ReclassifyProductUseCase', () => {
  let catalogRepository: InMemoryCatalogRepository;
  let categoryRepository: InMemoryCategoryRepository;
  let logger: PinoLoggerMock;
  let useCase: ReclassifyProductUseCase;

  beforeEach(() => {
    catalogRepository = new InMemoryCatalogRepository();
    categoryRepository = new InMemoryCategoryRepository();
    logger = makePinoLoggerMock();
    useCase = new ReclassifyProductUseCase(
      catalogRepository,
      categoryRepository,
      logger as unknown as PinoLogger,
    );

    catalogRepository.seed(seedProduct(PRODUCT_ID));
    categoryRepository.seed(seedCategory({ id: 1, slug: 'electronics', path: '/electronics' }));
    categoryRepository.seed(seedCategory({ id: 2, slug: 'phones', path: '/electronics/phones' }));
    categoryRepository.seed(
      seedCategory({
        id: 3,
        slug: 'clearance',
        path: '/clearance',
        status: CategoryStatusEnum.ARCHIVED,
      }),
    );
  });

  const payload = (overrides: Partial<IReclassifyProductPayload>): IReclassifyProductPayload => ({
    productId: PRODUCT_ID,
    attachCategorySlugs: [],
    detachCategorySlugs: [],
    correlationId: 'corr-1',
    ...overrides,
  });

  it('attaches and detaches in one command and returns the full current membership', async () => {
    await categoryRepository.attachProductCategories(PRODUCT_ID, [1]); // start in electronics

    const view = await useCase.execute(
      payload({ attachCategorySlugs: ['phones'], detachCategorySlugs: ['electronics'] }),
    );

    expect(view.product.id).toBe(PRODUCT_ID);
    expect(view.product.slug).toBe('classic-tee');
    expect(view.categories.map((category) => category.slug)).toEqual(['phones']);
  });

  it('is idempotent — re-attaching an existing membership and detaching a non-membership both succeed silently', async () => {
    await categoryRepository.attachProductCategories(PRODUCT_ID, [1]); // already in electronics

    const view = await useCase.execute(
      payload({
        attachCategorySlugs: ['electronics'], // re-attach an existing membership
        detachCategorySlugs: ['phones'], // detach a membership the product never had
      }),
    );

    // Membership is unchanged and the call did not throw.
    expect(view.categories.map((category) => category.slug)).toEqual(['electronics']);
  });

  it('rejects an unknown category in the attach list with CATEGORY_NOT_FOUND', async () => {
    await expect(
      useCase.execute(payload({ attachCategorySlugs: ['does-not-exist'] })),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_NOT_FOUND });
  });

  it('rejects an unknown category in the detach list with CATEGORY_NOT_FOUND', async () => {
    await expect(
      useCase.execute(payload({ detachCategorySlugs: ['does-not-exist'] })),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_NOT_FOUND });
  });

  it('rejects an unknown product with PRODUCT_NOT_FOUND', async () => {
    await expect(
      useCase.execute(payload({ productId: 999, attachCategorySlugs: ['electronics'] })),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.PRODUCT_NOT_FOUND });
  });

  it('rejects an archived category in the attach list with CATEGORY_ARCHIVED and writes nothing', async () => {
    await categoryRepository.attachProductCategories(PRODUCT_ID, [1]);

    await expect(
      useCase.execute(payload({ attachCategorySlugs: ['clearance'] })),
    ).rejects.toBeInstanceOf(CatalogDomainException);
    await expect(
      useCase.execute(payload({ attachCategorySlugs: ['clearance'] })),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_ARCHIVED });

    // The reject happens before any membership write — electronics is untouched.
    expect([...(categoryRepository.productCategories.get(PRODUCT_ID) ?? [])]).toEqual([1]);
  });

  it('allows detaching an archived category — a historic membership must stay removable', async () => {
    await categoryRepository.attachProductCategories(PRODUCT_ID, [1, 3]); // includes archived clearance

    const view = await useCase.execute(payload({ detachCategorySlugs: ['clearance'] }));

    expect(view.categories.map((category) => category.slug)).toEqual(['electronics']);
  });

  it('emits no event — the use case has no events-publisher dependency at all', () => {
    // The cleanest "emits nothing" guarantee is structural: the constructor takes
    // only the two repositories + the logger, so there is no publisher seam to
    // call. This test pins that constructor arity so a later refactor that smuggles
    // in a publisher fails loudly here.
    expect(ReclassifyProductUseCase.length).toBe(3);
  });
});
