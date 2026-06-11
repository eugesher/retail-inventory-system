import { PinoLogger } from 'nestjs-pino';

import {
  MediaAssetTypeEnum,
  MediaAssetView,
  MediaOwnerTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { MediaAsset, MediaAssetStatusEnum } from '../../../domain';
import { ListMediaUseCase } from '../list-media.use-case';
import { InMemoryMediaAssetRepository } from './test-doubles';

const seedMedia = (
  id: number,
  sortOrder: number,
  status = MediaAssetStatusEnum.ACTIVE,
): MediaAsset =>
  MediaAsset.reconstitute({
    id,
    ownerType: MediaOwnerTypeEnum.PRODUCT,
    ownerId: 42,
    uri: `https://cdn/${id}.jpg`,
    type: MediaAssetTypeEnum.IMAGE,
    altText: null,
    sortOrder,
    status,
  });

describe('ListMediaUseCase', () => {
  let repository: InMemoryMediaAssetRepository;
  let logger: PinoLoggerMock;
  let useCase: ListMediaUseCase;

  beforeEach(() => {
    repository = new InMemoryMediaAssetRepository();
    logger = makePinoLoggerMock();
    useCase = new ListMediaUseCase(repository, logger as unknown as PinoLogger);
  });

  const list = (ownerId = 42): Promise<MediaAssetView[]> =>
    useCase.execute({ ownerType: MediaOwnerTypeEnum.PRODUCT, ownerId, correlationId: 'corr-1' });

  it('returns the ACTIVE media sorted by sortOrder, excluding archived', async () => {
    // Seeded out of order, with one archived row.
    repository.seed(seedMedia(2, 1));
    repository.seed(seedMedia(1, 0));
    repository.seed(seedMedia(9, 2, MediaAssetStatusEnum.ARCHIVED));

    const views = await list();

    expect(views.map((view) => view.id)).toEqual([1, 2]);
    // The archived asset (id 9) is excluded; the remaining views are all active.
    expect(views.map((view) => view.status)).toEqual(['active', 'active']);
  });

  it('returns [] for an unknown owner (zero-answer, no 404)', async () => {
    await expect(list(404)).resolves.toEqual([]);
  });
});
