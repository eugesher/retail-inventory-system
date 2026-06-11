import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IDetachMediaPayload, MediaAssetView } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../../domain';
import { IMediaAssetRepositoryPort, MEDIA_ASSET_REPOSITORY } from '../ports';
import { toMediaAssetView } from './media-asset-view.factory';

// Detach Media archives one asset by its own id (`active → archived`). Detach is a
// STATUS FLIP, not a row delete: the row survives so anything that captured the id
// historically still resolves it (ADR-029 §4). It is STATE-GUARDED, not idempotent
// — a second detach of an already-archived asset is `MEDIA_INVALID_STATE_TRANSITION`
// (the domain enforces this). Remaining active siblings keep their `sortOrder`
// (no compaction — relative order is what browse sorts on). Records NO event.
@Injectable()
export class DetachMediaUseCase {
  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly mediaRepository: IMediaAssetRepositoryPort,
    @InjectPinoLogger(DetachMediaUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IDetachMediaPayload): Promise<MediaAssetView> {
    const { mediaId, correlationId } = payload;

    this.logger.info({ correlationId, mediaId }, 'Received RPC: detach media');

    const media = await this.mediaRepository.findById(mediaId);
    if (media === null) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.MEDIA_NOT_FOUND,
        `Media asset ${mediaId} not found`,
      );
    }

    // `active → archived`; a second detach throws `MEDIA_INVALID_STATE_TRANSITION`
    // (409) from the domain.
    media.archive();

    const saved = await this.mediaRepository.save(media);

    this.logger.info({ correlationId, mediaId }, 'Media detached (archived)');

    return toMediaAssetView(saved);
  }
}
