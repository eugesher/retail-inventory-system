import { PinoLogger } from 'nestjs-pino';
import { EntityManager, Repository } from 'typeorm';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Category, CategoryStatusEnum } from '../../../domain';
import { CategoryEntity } from '../category.entity';
import { CategoryMapper } from '../category.mapper';
import { CategoryTypeormRepository } from '../category-typeorm.repository';

describe('CategoryMapper', () => {
  it('round-trips a root category through domain → entity → domain', () => {
    const root = Category.create({ name: 'Electronics', slug: 'electronics' });

    const entity = {
      ...CategoryMapper.toEntity(root),
      id: 5,
      createdAt: new Date('2026-06-11T00:00:00Z'),
      updatedAt: new Date('2026-06-11T00:00:00Z'),
    } as CategoryEntity;

    const back = CategoryMapper.toDomain(entity);

    expect(back.id).toBe(5);
    expect(back.name).toBe('Electronics');
    expect(back.slug).toBe('electronics');
    expect(back.parentId).toBeNull();
    expect(back.path).toBe('/electronics');
    expect(back.sortOrder).toBe(0);
    expect(back.status).toBe(CategoryStatusEnum.ACTIVE);
  });

  it('omits the id for an unsaved category so TypeORM inserts it', () => {
    const entity = CategoryMapper.toEntity(Category.create({ name: 'X', slug: 'x' }));
    expect(entity.id).toBeUndefined();
    expect(entity.parentId).toBeNull();
    expect(entity.status).toBe(CategoryStatusEnum.ACTIVE);
  });

  it('coerces a string parent_id (mysql2 BIGINT) back to a number, preserving null for a root', () => {
    const child = CategoryMapper.toDomain({
      id: 10,
      name: 'Phones',
      slug: 'phones',
      // mysql2 surfaces a non-PK BIGINT as a string.
      parentId: '5' as unknown as number,
      path: '/electronics/phones',
      sortOrder: 2,
      status: CategoryStatusEnum.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as CategoryEntity);

    expect(child.parentId).toBe(5);
    expect(typeof child.parentId).toBe('number');
  });
});

describe('CategoryTypeormRepository', () => {
  let queryMock: jest.Mock;
  let transactionMock: jest.Mock;
  let categoryRepo: jest.Mocked<Pick<Repository<CategoryEntity>, 'existsBy' | 'findOne'>> & {
    manager: { transaction: jest.Mock };
  };
  let logger: PinoLoggerMock;
  let repository: CategoryTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    queryMock = jest.fn();
    // `manager.transaction(cb)` invokes the callback with a manager exposing the
    // same `query` mock, so the spec drives both UPDATEs through one stub.
    transactionMock = jest.fn(async (cb: (manager: EntityManager) => Promise<number>) =>
      cb({ query: queryMock } as unknown as EntityManager),
    );
    categoryRepo = {
      existsBy: jest.fn(),
      findOne: jest.fn(),
      manager: { transaction: transactionMock },
    } as never;
    logger = makePinoLoggerMock();
    repository = new CategoryTypeormRepository(
      categoryRepo as unknown as Repository<CategoryEntity>,
      logger as unknown as PinoLogger,
    );
  });

  describe('existsBySlug', () => {
    it('delegates to the repository and returns its result', async () => {
      categoryRepo.existsBy.mockResolvedValue(true);

      await expect(repository.existsBySlug('electronics')).resolves.toBe(true);
      expect(categoryRepo.existsBy).toHaveBeenCalledWith({ slug: 'electronics' });
    });
  });

  describe('findById', () => {
    it('returns null when no row matches', async () => {
      categoryRepo.findOne.mockResolvedValue(null);
      await expect(repository.findById(99)).resolves.toBeNull();
    });
  });

  describe('reparentSubtree', () => {
    it('issues the moved-row UPDATE then the single bulk rebase in one transaction and returns the affected count', async () => {
      // A child currently at /electronics/phones, already recomputed under /gadgets.
      const moved = Category.reconstitute({
        id: 10,
        name: 'Phones',
        slug: 'phones',
        parentId: 7,
        path: '/gadgets/phones',
        sortOrder: 0,
        status: CategoryStatusEnum.ACTIVE,
      });

      queryMock
        .mockResolvedValueOnce({ affectedRows: 1 }) // moved-row UPDATE
        .mockResolvedValueOnce({ affectedRows: 3 }); // bulk descendant rebase

      const count = await repository.reparentSubtree(moved, '/electronics/phones');

      expect(count).toBe(3);
      expect(transactionMock).toHaveBeenCalledTimes(1);

      // 1. The moved row: new parent_id + path, keyed on the id.
      expect(queryMock).toHaveBeenNthCalledWith(
        1,
        'UPDATE category SET parent_id = ?, path = ? WHERE id = ?',
        [7, '/gadgets/phones', 10],
      );

      // 2. The bulk rebase: CONCAT(newPath, SUBSTRING(path, LENGTH(oldPath)+1))
      //    over the `oldPath + '/%'` descendant set — all parameterized.
      expect(queryMock).toHaveBeenNthCalledWith(
        2,
        'UPDATE category SET path = CONCAT(?, SUBSTRING(path, ? + 1)) WHERE path LIKE ?',
        ['/gadgets/phones', '/electronics/phones'.length, '/electronics/phones/%'],
      );
    });

    it('throws when the category has no id', async () => {
      const unsaved = Category.create({ name: 'Phones', slug: 'phones' });
      await expect(repository.reparentSubtree(unsaved, '/phones')).rejects.toThrow(/has no id/);
    });
  });
});
