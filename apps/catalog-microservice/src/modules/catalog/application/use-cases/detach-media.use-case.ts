import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IDetachMediaPayload, MediaAssetView } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../../domain';
import { IMediaAssetRepositoryPort, MEDIA_ASSET_REPOSITORY } from '../ports';
import { toMediaAssetView } from './media-asset-view.factory';

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

    media.archive();

    const saved = await this.mediaRepository.save(media);

    this.logger.info({ correlationId, mediaId }, 'Media detached (archived)');

    return toMediaAssetView(saved);
  }
}
