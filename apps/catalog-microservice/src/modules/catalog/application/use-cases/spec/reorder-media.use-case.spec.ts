import { PinoLogger } from 'nestjs-pino';

import {
  MediaAssetTypeEnum,
  MediaAssetView,
  MediaOwnerTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { CatalogErrorCodeEnum, MediaAsset, MediaAssetStatusEnum } from '../../../domain';
import { ReorderMediaUseCase } from '../reorder-media.use-case';
import { InMemoryMediaAssetRepository } from './test-doubles';

const OWNER_TYPE = MediaOwnerTypeEnum.PRODUCT;
const OWNER_ID = 42;

const seedMedia = (
  id: number,
  sortOrder: number,
  status = MediaAssetStatusEnum.ACTIVE,
): MediaAsset =>
  MediaAsset.reconstitute({
    id,
    ownerType: OWNER_TYPE,
    ownerId: OWNER_ID,
    uri: `https://cdn/${id}.jpg`,
    type: MediaAssetTypeEnum.IMAGE,
    altText: null,
    sortOrder,
    status,
  });

describe('ReorderMediaUseCase', () => {
  let repository: InMemoryMediaAssetRepository;
  let logger: PinoLoggerMock;
  let useCase: ReorderMediaUseCase;

  beforeEach(() => {
    repository = new InMemoryMediaAssetRepository();
    logger = makePinoLoggerMock();
    useCase = new ReorderMediaUseCase(repository, logger as unknown as PinoLogger);

    // Active assets 1,2,3 at slots 0,1,2 plus an ARCHIVED asset 9 at slot 3.
    repository.seed(seedMedia(1, 0));
    repository.seed(seedMedia(2, 1));
    repository.seed(seedMedia(3, 2));
    repository.seed(seedMedia(9, 3, MediaAssetStatusEnum.ARCHIVED));
  });

  const reorder = (ids: number[]): Promise<MediaAssetView[]> =>
    useCase.execute({
      ownerType: OWNER_TYPE,
      ownerId: OWNER_ID,
      mediaIdsInOrder: ids,
      correlationId: 'corr-1',
    });

  it('applies a valid permutation exactly once and returns the new order', async () => {
    const views = await reorder([3, 1, 2]);

    // `reorder` was called exactly once with the requested order.
    expect(repository.reorderCalls).toHaveLength(1);
    expect(repository.reorderCalls[0]).toMatchObject({
      ownerType: OWNER_TYPE,
      ownerId: OWNER_ID,
      orderedIds: [3, 1, 2],
    });

    // The refreshed ACTIVE list reflects the new slots (3→0, 1→1, 2→2); the
    // archived asset 9 is absent.
    expect(views.map((view) => view.id)).toEqual([3, 1, 2]);
    expect(views.map((view) => view.sortOrder)).toEqual([0, 1, 2]);
  });

  it.each<[string, number[]]>([
    ['a missing id', [1, 2]],
    ['a duplicate id', [1, 1, 2]],
    ['a foreign id', [1, 2, 7]],
    ['an archived id', [1, 2, 9]],
  ])('rejects %s with MEDIA_REORDER_SET_MISMATCH and never calls reorder', async (_label, ids) => {
    await expect(reorder(ids)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.MEDIA_REORDER_SET_MISMATCH,
    });
    expect(repository.reorderCalls).toHaveLength(0);
  });
});
