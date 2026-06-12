import { PinoLogger } from 'nestjs-pino';

import { ICreateCategoryPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  CatalogDomainException,
  CatalogErrorCodeEnum,
  Category,
  CategoryStatusEnum,
} from '../../../domain';
import { CreateCategoryUseCase } from '../create-category.use-case';
import { InMemoryCategoryRepository } from './test-doubles';

// Reconstitutes a persisted category to seed the in-memory repo (a parent the
// create resolves by slug). `create` always starts a fresh `active` root/child,
// so a seeded row uses `reconstitute` to pin a known id/path/status.
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

describe('CreateCategoryUseCase', () => {
  let repository: InMemoryCategoryRepository;
  let logger: PinoLoggerMock;
  let useCase: CreateCategoryUseCase;

  beforeEach(() => {
    repository = new InMemoryCategoryRepository();
    logger = makePinoLoggerMock();
    useCase = new CreateCategoryUseCase(repository, logger as unknown as PinoLogger);
  });

  const rootPayload: ICreateCategoryPayload = {
    name: 'Electronics',
    slug: 'electronics',
    correlationId: 'corr-1',
  };

  it('creates a root category with path `/<slug>` and a null parentId', async () => {
    const view = await useCase.execute(rootPayload);

    expect(view.id).toEqual(expect.any(Number));
    expect(view.name).toBe('Electronics');
    expect(view.slug).toBe('electronics');
    expect(view.parentId).toBeNull();
    expect(view.path).toBe('/electronics');
    expect(view.status).toBe(CategoryStatusEnum.ACTIVE);

    expect(repository.saved).toHaveLength(1);
  });

  it('creates a child category with path `parent.path + /<slug>`', async () => {
    repository.seed(seedCategory({ id: 5, slug: 'electronics', path: '/electronics' }));

    const view = await useCase.execute({
      name: 'Phones',
      slug: 'phones',
      parentSlug: 'electronics',
      correlationId: 'corr-2',
    });

    expect(view.parentId).toBe(5);
    expect(view.path).toBe('/electronics/phones');
  });

  it('rejects a duplicate slug with CATEGORY_SLUG_TAKEN before persisting', async () => {
    repository.slugTaken = true;

    await expect(useCase.execute(rootPayload)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.CATEGORY_SLUG_TAKEN,
    });
    await expect(useCase.execute(rootPayload)).rejects.toBeInstanceOf(CatalogDomainException);

    expect(repository.saved).toHaveLength(0);
  });

  it('rejects an unknown parentSlug with CATEGORY_PARENT_NOT_FOUND', async () => {
    await expect(
      useCase.execute({
        name: 'Phones',
        slug: 'phones',
        parentSlug: 'does-not-exist',
        correlationId: 'corr-3',
      }),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_PARENT_NOT_FOUND });

    expect(repository.saved).toHaveLength(0);
  });

  it('rejects an archived parent with CATEGORY_ARCHIVED', async () => {
    repository.seed(
      seedCategory({
        id: 9,
        slug: 'electronics',
        path: '/electronics',
        status: CategoryStatusEnum.ARCHIVED,
      }),
    );

    await expect(
      useCase.execute({
        name: 'Phones',
        slug: 'phones',
        parentSlug: 'electronics',
        correlationId: 'corr-4',
      }),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.CATEGORY_ARCHIVED });

    expect(repository.saved).toHaveLength(0);
  });
});
