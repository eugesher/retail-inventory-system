import { PinoLogger } from 'nestjs-pino';

import { CategoryTreeNodeView } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { CatalogErrorCodeEnum, Category, CategoryStatusEnum } from '../../../domain';
import { GetCategoryTreeUseCase } from '../get-category-tree.use-case';
import { InMemoryCategoryRepository } from './test-doubles';

const seedCategory = (overrides: {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
  path: string;
  sortOrder?: number;
  status?: CategoryStatusEnum;
}): Category =>
  Category.reconstitute({
    id: overrides.id,
    name: overrides.name,
    slug: overrides.slug,
    parentId: overrides.parentId,
    path: overrides.path,
    sortOrder: overrides.sortOrder ?? 0,
    status: overrides.status ?? CategoryStatusEnum.ACTIVE,
  });

const childSlugs = (node: CategoryTreeNodeView): string[] =>
  node.children.map((child) => child.slug);

describe('GetCategoryTreeUseCase', () => {
  let repository: InMemoryCategoryRepository;
  let logger: PinoLoggerMock;
  let useCase: GetCategoryTreeUseCase;

  beforeEach(() => {
    repository = new InMemoryCategoryRepository();
    logger = makePinoLoggerMock();
    useCase = new GetCategoryTreeUseCase(repository, logger as unknown as PinoLogger);

    // electronics
    //   ├─ laptops (sortOrder 0)
    //   │    └─ gaming
    //   ├─ phones (sortOrder 1)
    //   └─ accessories (ARCHIVED)
    //        └─ cables (active, but orphaned under an archived parent)
    repository.seed(
      seedCategory({
        id: 1,
        name: 'Electronics',
        slug: 'electronics',
        parentId: null,
        path: '/electronics',
      }),
    );
    repository.seed(
      seedCategory({
        id: 2,
        name: 'Phones',
        slug: 'phones',
        parentId: 1,
        path: '/electronics/phones',
        sortOrder: 1,
      }),
    );
    repository.seed(
      seedCategory({
        id: 3,
        name: 'Laptops',
        slug: 'laptops',
        parentId: 1,
        path: '/electronics/laptops',
        sortOrder: 0,
      }),
    );
    repository.seed(
      seedCategory({
        id: 4,
        name: 'Gaming',
        slug: 'gaming',
        parentId: 3,
        path: '/electronics/laptops/gaming',
      }),
    );
    repository.seed(
      seedCategory({
        id: 5,
        name: 'Accessories',
        slug: 'accessories',
        parentId: 1,
        path: '/electronics/accessories',
        status: CategoryStatusEnum.ARCHIVED,
      }),
    );
    repository.seed(
      seedCategory({
        id: 6,
        name: 'Cables',
        slug: 'cables',
        parentId: 5,
        path: '/electronics/accessories/cables',
      }),
    );
  });

  it('assembles the active subtree with children sorted sortOrder ASC then name ASC', async () => {
    const tree = await useCase.execute({ slug: 'electronics', correlationId: 'corr-1' });

    expect(tree.slug).toBe('electronics');
    // Laptops (sortOrder 0) before Phones (sortOrder 1); the archived Accessories
    // branch is dropped entirely.
    expect(childSlugs(tree)).toEqual(['laptops', 'phones']);

    const laptops = tree.children.find((child) => child.slug === 'laptops');
    expect(childSlugs(laptops!)).toEqual(['gaming']);
  });

  it('drops a branch whose intermediate ancestor is archived (cables under archived accessories)', async () => {
    const tree = await useCase.execute({ slug: 'electronics', correlationId: 'corr-2' });

    const allSlugs = (node: CategoryTreeNodeView): string[] => [
      node.slug,
      ...node.children.flatMap(allSlugs),
    ];

    // accessories (archived) and its active child cables never appear: an archived
    // intermediate hides its whole subtree.
    expect(allSlugs(tree)).not.toContain('accessories');
    expect(allSlugs(tree)).not.toContain('cables');
  });

  it('returns a leaf with an empty children array', async () => {
    const tree = await useCase.execute({ slug: 'gaming', correlationId: 'corr-3' });

    expect(tree.slug).toBe('gaming');
    expect(tree.children).toEqual([]);
  });

  it('rejects a missing slug with CATEGORY_NOT_FOUND', async () => {
    await expect(
      useCase.execute({ slug: 'does-not-exist', correlationId: 'corr-4' }),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_NOT_FOUND });
  });

  it('rejects an archived category with CATEGORY_NOT_FOUND (hidden from browse)', async () => {
    await expect(
      useCase.execute({ slug: 'accessories', correlationId: 'corr-5' }),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_NOT_FOUND });
  });
});
