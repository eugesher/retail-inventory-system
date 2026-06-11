import { PinoLogger } from 'nestjs-pino';

import {
  MediaAssetTypeEnum,
  MediaAssetView,
  MediaOwnerTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { CatalogErrorCodeEnum, MediaAsset, MediaAssetStatusEnum } from '../../../domain';
import { DetachMediaUseCase } from '../detach-media.use-case';
import { InMemoryMediaAssetRepository } from './test-doubles';

const seedMedia = (id: number, sortOrder: number): MediaAsset =>
  MediaAsset.reconstitute({
    id,
    ownerType: MediaOwnerTypeEnum.PRODUCT,
    ownerId: 42,
    uri: `https://cdn/${id}.jpg`,
    type: MediaAssetTypeEnum.IMAGE,
    altText: null,
    sortOrder,
    status: MediaAssetStatusEnum.ACTIVE,
  });

describe('DetachMediaUseCase', () => {
  let repository: InMemoryMediaAssetRepository;
  let logger: PinoLoggerMock;
  let useCase: DetachMediaUseCase;

  beforeEach(() => {
    repository = new InMemoryMediaAssetRepository();
    logger = makePinoLoggerMock();
    useCase = new DetachMediaUseCase(repository, logger as unknown as PinoLogger);
  });

  const detach = (mediaId: number): Promise<MediaAssetView> =>
    useCase.execute({ mediaId, correlationId: 'corr-1' });

  it('archives the asset and returns the archived view', async () => {
    repository.seed(seedMedia(1, 0));

    const view = await detach(1);

    expect(view.id).toBe(1);
    expect(view.status).toBe(MediaAssetStatusEnum.ARCHIVED);
  });

  it('rejects a second detach (state-guarded) with MEDIA_INVALID_STATE_TRANSITION', async () => {
    repository.seed(seedMedia(1, 0));

    await detach(1);
    await expect(detach(1)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.MEDIA_INVALID_STATE_TRANSITION,
    });
  });

  it('rejects an unknown media id with MEDIA_NOT_FOUND', async () => {
    await expect(detach(404)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.MEDIA_NOT_FOUND,
    });
  });

  it('leaves an active sibling sortOrder untouched (no compaction)', async () => {
    repository.seed(seedMedia(1, 0));
    repository.seed(seedMedia(2, 1));

    await detach(1);

    const sibling = await repository.findById(2);
    expect(sibling?.sortOrder).toBe(1);
    expect(sibling?.isActive()).toBe(true);
  });
});
