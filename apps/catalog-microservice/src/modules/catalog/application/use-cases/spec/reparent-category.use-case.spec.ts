import { PinoLogger } from 'nestjs-pino';

import { IReparentCategoryPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  CatalogDomainException,
  CatalogErrorCodeEnum,
  Category,
  CategoryStatusEnum,
} from '../../../domain';
import { ReparentCategoryUseCase } from '../reparent-category.use-case';
import { InMemoryCategoryRepository } from './test-doubles';

const seedCategory = (overrides: {
  id: number;
  name?: string;
  slug: string;
  parentId?: number | null;
  path: string;
  status?: CategoryStatusEnum;
}): Category =>
  Category.reconstitute({
    id: overrides.id,
    name: overrides.name ?? overrides.slug,
    slug: overrides.slug,
    parentId: overrides.parentId ?? null,
    path: overrides.path,
    sortOrder: 0,
    status: overrides.status ?? CategoryStatusEnum.ACTIVE,
  });

describe('ReparentCategoryUseCase', () => {
  let repository: InMemoryCategoryRepository;
  let logger: PinoLoggerMock;
  let useCase: ReparentCategoryUseCase;

  beforeEach(() => {
    repository = new InMemoryCategoryRepository();
    logger = makePinoLoggerMock();
    useCase = new ReparentCategoryUseCase(repository, logger as unknown as PinoLogger);
  });

  it('reparents under a new parent: calls reparentSubtree with the recomputed aggregate + the captured oldPath, and surfaces the rewrite count', async () => {
    repository.seed(seedCategory({ id: 5, slug: 'electronics', path: '/electronics' }));
    repository.seed(
      seedCategory({ id: 10, slug: 'phones', parentId: 5, path: '/electronics/phones' }),
    );
    repository.seed(seedCategory({ id: 7, slug: 'gadgets', path: '/gadgets' }));
    repository.reparentReturnCount = 3;

    const payload: IReparentCategoryPayload = {
      slug: 'phones',
      newParentSlug: 'gadgets',
      correlationId: 'corr-1',
    };
    const view = await useCase.execute(payload);

    // The repository received the moved aggregate already recomputed to its new
    // position, plus the path it held BEFORE the move (so the bulk descendant
    // rebase can match the old subtree prefix). This is the "descendants
    // recomputed in the same transaction" guarantee asserted at the use-case
    // altitude — the single-transaction mechanics live in the repository spec.
    expect(repository.reparentCalls).toHaveLength(1);
    const [call] = repository.reparentCalls;
    expect(call.oldPath).toBe('/electronics/phones');
    expect(call.category.id).toBe(10);
    expect(call.category.parentId).toBe(7);
    expect(call.category.path).toBe('/gadgets/phones');

    // The repository's descendant-rewrite count is threaded through unchanged.
    expect(view.rewrittenDescendantCount).toBe(3);
    expect(view.category.parentId).toBe(7);
    expect(view.category.path).toBe('/gadgets/phones');
  });

  it('demotes to a root when newParentSlug is absent — path recomputes to `/<slug>`', async () => {
    repository.seed(
      seedCategory({ id: 10, slug: 'phones', parentId: 5, path: '/electronics/phones' }),
    );
    repository.reparentReturnCount = 0;

    const view = await useCase.execute({ slug: 'phones', correlationId: 'corr-2' });

    expect(view.category.parentId).toBeNull();
    expect(view.category.path).toBe('/phones');
    expect(view.rewrittenDescendantCount).toBe(0);
    expect(repository.reparentCalls[0].oldPath).toBe('/electronics/phones');
  });

  it('treats a reparent under the CURRENT parent as an idempotent success (not an error)', async () => {
    repository.seed(seedCategory({ id: 5, slug: 'electronics', path: '/electronics' }));
    repository.seed(
      seedCategory({ id: 10, slug: 'phones', parentId: 5, path: '/electronics/phones' }),
    );

    const view = await useCase.execute({
      slug: 'phones',
      newParentSlug: 'electronics',
      correlationId: 'corr-3',
    });

    expect(view.category.parentId).toBe(5);
    expect(view.category.path).toBe('/electronics/phones');
    expect(repository.reparentCalls).toHaveLength(1);
  });

  it('rejects reparenting a category under ITSELF with CATEGORY_CYCLE', async () => {
    repository.seed(seedCategory({ id: 1, slug: 'a', path: '/a' }));

    await expect(
      useCase.execute({ slug: 'a', newParentSlug: 'a', correlationId: 'corr-4' }),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_CYCLE });
    await expect(
      useCase.execute({ slug: 'a', newParentSlug: 'a', correlationId: 'corr-4' }),
    ).rejects.toBeInstanceOf(CatalogDomainException);

    expect(repository.reparentCalls).toHaveLength(0);
  });

  it('rejects reparenting a category under one of its DESCENDANTS with CATEGORY_CYCLE', async () => {
    repository.seed(seedCategory({ id: 1, slug: 'a', path: '/a' }));
    repository.seed(seedCategory({ id: 2, slug: 'b', parentId: 1, path: '/a/b' }));

    await expect(
      useCase.execute({ slug: 'a', newParentSlug: 'b', correlationId: 'corr-5' }),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_CYCLE });

    expect(repository.reparentCalls).toHaveLength(0);
  });

  it('rejects an unknown category slug with CATEGORY_NOT_FOUND', async () => {
    await expect(
      useCase.execute({ slug: 'unknown', newParentSlug: null, correlationId: 'corr-6' }),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_NOT_FOUND });

    expect(repository.reparentCalls).toHaveLength(0);
  });

  it('rejects an unknown new parent with CATEGORY_PARENT_NOT_FOUND', async () => {
    repository.seed(
      seedCategory({ id: 10, slug: 'phones', parentId: 5, path: '/electronics/phones' }),
    );

    await expect(
      useCase.execute({ slug: 'phones', newParentSlug: 'ghost', correlationId: 'corr-7' }),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_PARENT_NOT_FOUND });

    expect(repository.reparentCalls).toHaveLength(0);
  });

  it('rejects an archived new parent with CATEGORY_ARCHIVED', async () => {
    repository.seed(
      seedCategory({ id: 10, slug: 'phones', parentId: 5, path: '/electronics/phones' }),
    );
    repository.seed(
      seedCategory({
        id: 7,
        slug: 'gadgets',
        path: '/gadgets',
        status: CategoryStatusEnum.ARCHIVED,
      }),
    );

    await expect(
      useCase.execute({ slug: 'phones', newParentSlug: 'gadgets', correlationId: 'corr-8' }),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_ARCHIVED });

    expect(repository.reparentCalls).toHaveLength(0);
  });
});
