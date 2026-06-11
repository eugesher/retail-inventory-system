import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  CatalogErrorCodeEnum,
  Category,
  CategoryStatusEnum,
  Product,
  ProductStatusEnum,
} from '../../../domain';
import { ListCategoryProductsUseCase } from '../list-category-products.use-case';
import { InMemoryCatalogRepository, InMemoryCategoryRepository } from './test-doubles';

const seedProduct = (id: number, slug: string): Product =>
  Product.reconstitute({
    id,
    name: slug,
    slug,
    description: '',
    status: ProductStatusEnum.ACTIVE,
    variants: [],
  });

const seedCategory = (overrides: {
  id: number;
  slug: string;
  parentId: number | null;
  path: string;
  status?: CategoryStatusEnum;
}): Category =>
  Category.reconstitute({
    id: overrides.id,
    name: overrides.slug,
    slug: overrides.slug,
    parentId: overrides.parentId,
    path: overrides.path,
    sortOrder: 0,
    status: overrides.status ?? CategoryStatusEnum.ACTIVE,
  });

describe('ListCategoryProductsUseCase', () => {
  let catalogRepository: InMemoryCatalogRepository;
  let categoryRepository: InMemoryCategoryRepository;
  let logger: PinoLoggerMock;
  let useCase: ListCategoryProductsUseCase;

  beforeEach(() => {
    catalogRepository = new InMemoryCatalogRepository();
    categoryRepository = new InMemoryCategoryRepository();
    logger = makePinoLoggerMock();
    useCase = new ListCategoryProductsUseCase(
      catalogRepository,
      categoryRepository,
      logger as unknown as PinoLogger,
    );

    // electronics (id 1) → phones (id 2, child).
    categoryRepository.seed(
      seedCategory({ id: 1, slug: 'electronics', parentId: null, path: '/electronics' }),
    );
    categoryRepository.seed(
      seedCategory({ id: 2, slug: 'phones', parentId: 1, path: '/electronics/phones' }),
    );

    // p100, p101 directly in electronics; p102 in phones (the descendant).
    catalogRepository.seed(seedProduct(100, 'p100'));
    catalogRepository.seed(seedProduct(101, 'p101'));
    catalogRepository.seed(seedProduct(102, 'p102'));
    catalogRepository.attachProductToCategory(100, 1);
    catalogRepository.attachProductToCategory(101, 1);
    catalogRepository.attachProductToCategory(102, 2);
  });

  it('lists only the named category by default (includeDescendants off)', async () => {
    const page = await useCase.execute({ slug: 'electronics', correlationId: 'corr-1' });

    // Only electronics members — newest-first by id.
    expect(page.items.map((item) => item.slug)).toEqual(['p101', 'p100']);
    expect(page.total).toBe(2);
    // The browse asked for the single category id only.
    expect(catalogRepository.listByCategoryCalls.at(-1)).toEqual([1]);
  });

  it('expands to the active subtree ids when includeDescendants is set', async () => {
    const page = await useCase.execute({
      slug: 'electronics',
      includeDescendants: true,
      correlationId: 'corr-2',
    });

    // electronics members + the phones (descendant) member.
    expect(page.items.map((item) => item.slug)).toEqual(['p102', 'p101', 'p100']);
    expect(page.total).toBe(3);
    // The resolved id set covers self + the descendant.
    expect([...(catalogRepository.listByCategoryCalls.at(-1) ?? [])].sort()).toEqual([1, 2]);
  });

  it('passes paging through to the repository', async () => {
    const page = await useCase.execute({
      slug: 'electronics',
      includeDescendants: true,
      page: 2,
      pageSize: 2,
      correlationId: 'corr-3',
    });

    // 3 matches, page 2 of size 2 → the trailing 1 item; metadata echoes the input.
    expect(page.page).toBe(2);
    expect(page.size).toBe(2);
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
  });

  it('rejects a missing category with CATEGORY_NOT_FOUND', async () => {
    await expect(
      useCase.execute({ slug: 'does-not-exist', correlationId: 'corr-4' }),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_NOT_FOUND });
  });

  it('rejects an archived category with CATEGORY_NOT_FOUND', async () => {
    categoryRepository.seed(
      seedCategory({
        id: 9,
        slug: 'clearance',
        parentId: null,
        path: '/clearance',
        status: CategoryStatusEnum.ARCHIVED,
      }),
    );

    await expect(
      useCase.execute({ slug: 'clearance', correlationId: 'corr-5' }),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_NOT_FOUND });
  });
});
