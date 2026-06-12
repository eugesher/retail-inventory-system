import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Category, CategoryStatusEnum } from '../../../domain';
import { ListCategoriesUseCase } from '../list-categories.use-case';
import { InMemoryCategoryRepository } from './test-doubles';

const seedCategory = (overrides: {
  id: number;
  name: string;
  slug: string;
  parentId?: number | null;
  path: string;
  sortOrder?: number;
  status?: CategoryStatusEnum;
}): Category =>
  Category.reconstitute({
    id: overrides.id,
    name: overrides.name,
    slug: overrides.slug,
    parentId: overrides.parentId ?? null,
    path: overrides.path,
    sortOrder: overrides.sortOrder ?? 0,
    status: overrides.status ?? CategoryStatusEnum.ACTIVE,
  });

describe('ListCategoriesUseCase', () => {
  let repository: InMemoryCategoryRepository;
  let logger: PinoLoggerMock;
  let useCase: ListCategoriesUseCase;

  beforeEach(() => {
    repository = new InMemoryCategoryRepository();
    logger = makePinoLoggerMock();
    useCase = new ListCategoriesUseCase(repository, logger as unknown as PinoLogger);

    // Two roots (Books sorts before Electronics: sortOrder 0 vs 1), one child, one
    // archived root that must never surface in a public browse.
    repository.seed(
      seedCategory({
        id: 1,
        name: 'Electronics',
        slug: 'electronics',
        path: '/electronics',
        sortOrder: 1,
      }),
    );
    repository.seed(
      seedCategory({ id: 2, name: 'Books', slug: 'books', path: '/books', sortOrder: 0 }),
    );
    repository.seed(
      seedCategory({
        id: 3,
        name: 'Phones',
        slug: 'phones',
        parentId: 1,
        path: '/electronics/phones',
      }),
    );
    repository.seed(
      seedCategory({
        id: 4,
        name: 'Clearance',
        slug: 'clearance',
        path: '/clearance',
        status: CategoryStatusEnum.ARCHIVED,
      }),
    );
  });

  it('lists every active category, ordered sortOrder ASC then name ASC, hiding archived', async () => {
    const views = await useCase.execute({ correlationId: 'corr-1' });

    // Books (sortOrder 0), then Electronics (sortOrder 1), then Phones (sortOrder 0
    // but a deeper path) — the flat list is purely sortOrder/name ordered. The
    // archived Clearance is absent.
    expect(views.map((view) => view.slug)).toEqual(['books', 'phones', 'electronics']);
    // The archived Clearance never surfaces in a public browse.
    expect(views.map((view) => view.slug)).not.toContain('clearance');
  });

  it('narrows to top-level categories with rootOnly', async () => {
    const views = await useCase.execute({ rootOnly: true, correlationId: 'corr-2' });

    // Only the active roots (Books, Electronics) — Phones is a child, Clearance is
    // archived.
    expect(views.map((view) => view.slug)).toEqual(['books', 'electronics']);
    expect(views.every((view) => view.parentId === null)).toBe(true);
  });
});
