import { EntityManager, Repository } from 'typeorm';

import { MediaAssetTypeEnum, MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';

import { MediaAsset, MediaAssetStatusEnum } from '../../../domain';
import { MediaAssetEntity } from '../media-asset.entity';
import { MediaAssetMapper } from '../media-asset.mapper';
import { MediaAssetTypeormRepository } from '../media-asset-typeorm.repository';

describe('MediaAssetMapper', () => {
  it('round-trips an asset through domain → entity → domain', () => {
    const asset = MediaAsset.create({
      ownerType: MediaOwnerTypeEnum.PRODUCT,
      ownerId: 42,
      uri: 'https://cdn.example.com/a.jpg',
      type: MediaAssetTypeEnum.IMAGE,
      altText: 'alt',
      sortOrder: 2,
    });

    const entity = {
      ...MediaAssetMapper.toEntity(asset),
      id: 7,
      createdAt: new Date('2026-06-11T00:00:00Z'),
      updatedAt: new Date('2026-06-11T00:00:00Z'),
    } as MediaAssetEntity;

    const back = MediaAssetMapper.toDomain(entity);

    expect(back.id).toBe(7);
    expect(back.ownerType).toBe(MediaOwnerTypeEnum.PRODUCT);
    expect(back.ownerId).toBe(42);
    expect(back.uri).toBe('https://cdn.example.com/a.jpg');
    expect(back.type).toBe(MediaAssetTypeEnum.IMAGE);
    expect(back.altText).toBe('alt');
    expect(back.sortOrder).toBe(2);
    expect(back.status).toBe(MediaAssetStatusEnum.ACTIVE);
  });

  it('omits the id for an unsaved asset so TypeORM inserts it', () => {
    const entity = MediaAssetMapper.toEntity(
      MediaAsset.create({
        ownerType: MediaOwnerTypeEnum.PRODUCT_VARIANT,
        ownerId: 5,
        uri: 's3://bucket/key',
        type: MediaAssetTypeEnum.DOCUMENT,
        sortOrder: 0,
      }),
    );
    expect(entity.id).toBeUndefined();
    expect(entity.altText).toBeNull();
    expect(entity.status).toBe(MediaAssetStatusEnum.ACTIVE);
  });

  it('coerces a string owner_id (mysql2 BIGINT) back to a number', () => {
    const back = MediaAssetMapper.toDomain({
      id: 10,
      ownerType: MediaOwnerTypeEnum.PRODUCT,
      // mysql2 surfaces a non-PK BIGINT as a string.
      ownerId: '42' as unknown as number,
      uri: 'https://x',
      type: MediaAssetTypeEnum.IMAGE,
      altText: null,
      sortOrder: 0,
      status: MediaAssetStatusEnum.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as MediaAssetEntity);

    expect(back.ownerId).toBe(42);
    expect(typeof back.ownerId).toBe('number');
  });
});

describe('MediaAssetTypeormRepository', () => {
  let txQueryMock: jest.Mock;
  let transactionMock: jest.Mock;
  let findMock: jest.Mock;
  let createQueryBuilderMock: jest.Mock;
  let mediaRepo: jest.Mocked<Pick<Repository<MediaAssetEntity>, 'find' | 'createQueryBuilder'>> & {
    manager: { transaction: jest.Mock };
  };
  let repository: MediaAssetTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    txQueryMock = jest.fn().mockResolvedValue(undefined);
    findMock = jest.fn();
    createQueryBuilderMock = jest.fn();
    // `manager.transaction(cb)` invokes the callback with a manager exposing a
    // `query` mock, so the spec drives every slot UPDATE through one stub.
    transactionMock = jest.fn(async (cb: (manager: EntityManager) => Promise<void>) =>
      cb({ query: txQueryMock } as unknown as EntityManager),
    );
    mediaRepo = {
      find: findMock,
      createQueryBuilder: createQueryBuilderMock,
      manager: { transaction: transactionMock },
    } as never;
    repository = new MediaAssetTypeormRepository(
      mediaRepo as unknown as Repository<MediaAssetEntity>,
    );
  });

  describe('reorder', () => {
    it('issues one parameterized slot UPDATE per id inside a SINGLE transaction, then re-reads the active list', async () => {
      // After commit, the refreshed active list is returned (sorted by the repo's
      // `find` order). The two ids become slots 0 and 1.
      findMock.mockResolvedValue([
        {
          id: 3,
          ownerType: MediaOwnerTypeEnum.PRODUCT,
          ownerId: 42,
          uri: 'https://b',
          type: MediaAssetTypeEnum.IMAGE,
          altText: null,
          sortOrder: 0,
          status: MediaAssetStatusEnum.ACTIVE,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        } as MediaAssetEntity,
      ]);

      await repository.reorder(MediaOwnerTypeEnum.PRODUCT, 42, [3, 7]);

      // Exactly one transaction wraps every UPDATE — the all-or-nothing guarantee.
      expect(transactionMock).toHaveBeenCalledTimes(1);

      // Slot = array index, owner-scoped, fully parameterized (ids bound, never
      // interpolated).
      expect(txQueryMock).toHaveBeenNthCalledWith(
        1,
        'UPDATE media_asset SET sort_order = ? WHERE id = ? AND owner_type = ? AND owner_id = ?',
        [0, 3, MediaOwnerTypeEnum.PRODUCT, 42],
      );
      expect(txQueryMock).toHaveBeenNthCalledWith(
        2,
        'UPDATE media_asset SET sort_order = ? WHERE id = ? AND owner_type = ? AND owner_id = ?',
        [1, 7, MediaOwnerTypeEnum.PRODUCT, 42],
      );

      // The post-commit re-read is the owner's ACTIVE list.
      expect(findMock).toHaveBeenCalledWith({
        where: {
          ownerType: MediaOwnerTypeEnum.PRODUCT,
          ownerId: 42,
          status: MediaAssetStatusEnum.ACTIVE,
        },
        order: { sortOrder: 'ASC', id: 'ASC' },
      });
    });
  });

  describe('maxSortOrder', () => {
    const buildBuilder = (
      raw: { max: string | number | null } | undefined,
    ): Record<'select' | 'where' | 'andWhere' | 'getRawOne', jest.Mock> => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(raw),
    });

    it('returns null when the owner has no media (MAX is NULL)', async () => {
      createQueryBuilderMock.mockReturnValue(buildBuilder({ max: null }));

      await expect(repository.maxSortOrder(MediaOwnerTypeEnum.PRODUCT, 42)).resolves.toBeNull();
    });

    it('coerces a string MAX (mysql2 aggregate) to a number', async () => {
      createQueryBuilderMock.mockReturnValue(buildBuilder({ max: '4' }));

      await expect(repository.maxSortOrder(MediaOwnerTypeEnum.PRODUCT, 42)).resolves.toBe(4);
    });
  });
});
