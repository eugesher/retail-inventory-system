import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IReorderMediaPayload, MediaAssetView } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../../domain';
import { IMediaAssetRepositoryPort, MEDIA_ASSET_REPOSITORY } from '../ports';
import { toMediaAssetView } from './media-asset-view.factory';

@Injectable()
export class ReorderMediaUseCase {
  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly mediaRepository: IMediaAssetRepositoryPort,
    @InjectPinoLogger(ReorderMediaUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IReorderMediaPayload): Promise<MediaAssetView[]> {
    const { ownerType, ownerId, mediaIdsInOrder, correlationId } = payload;

    this.logger.info(
      { correlationId, ownerType, ownerId, count: mediaIdsInOrder.length },
      'Received RPC: reorder media',
    );

    const active = await this.mediaRepository.listByOwner(ownerType, ownerId, { activeOnly: true });
    const activeIds = new Set(active.map((media) => media.id));

    const uniqueRequested = new Set(mediaIdsInOrder);
    const isExactPermutation =
      mediaIdsInOrder.length === activeIds.size &&
      uniqueRequested.size === mediaIdsInOrder.length &&
      mediaIdsInOrder.every((id) => activeIds.has(id));

    if (!isExactPermutation) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.MEDIA_REORDER_SET_MISMATCH,
        'Reorder ids must be an exact permutation of the active media set (no missing, duplicate, foreign, or archived ids)',
      );
    }

    const reordered = await this.mediaRepository.reorder(ownerType, ownerId, mediaIdsInOrder);

    this.logger.info({ correlationId, ownerType, ownerId }, 'Media reordered');

    return reordered.map(toMediaAssetView);
  }
}
