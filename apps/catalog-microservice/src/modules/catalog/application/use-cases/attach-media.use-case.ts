import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IAttachMediaPayload,
  MediaAssetView,
  MediaOwnerTypeEnum,
} from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, MediaAsset } from '../../domain';
import {
  CATALOG_REPOSITORY,
  ICatalogRepositoryPort,
  IMediaAssetRepositoryPort,
  MEDIA_ASSET_REPOSITORY,
} from '../ports';
import { toMediaAssetView } from './media-asset-view.factory';

@Injectable()
export class AttachMediaUseCase {
  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly mediaRepository: IMediaAssetRepositoryPort,
    @Inject(CATALOG_REPOSITORY)
    private readonly catalogRepository: ICatalogRepositoryPort,
    @InjectPinoLogger(AttachMediaUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IAttachMediaPayload): Promise<MediaAssetView> {
    const { ownerType, ownerId, uri, type, altText, correlationId } = payload;

    this.logger.info({ correlationId, ownerType, ownerId, type }, 'Received RPC: attach media');

    await this.assertOwnerExists(ownerType, ownerId);

    const maxSortOrder = await this.mediaRepository.maxSortOrder(ownerType, ownerId);
    const sortOrder = (maxSortOrder ?? -1) + 1;

    const media = MediaAsset.create({ ownerType, ownerId, uri, type, altText, sortOrder });

    const saved = await this.mediaRepository.save(media);
    if (saved.id === null) {
      throw new Error('AttachMediaUseCase: repository returned an unsaved aggregate');
    }

    this.logger.info(
      { correlationId, mediaId: saved.id, ownerType, ownerId, sortOrder },
      'Media attached',
    );

    return toMediaAssetView(saved);
  }

  private async assertOwnerExists(ownerType: MediaOwnerTypeEnum, ownerId: number): Promise<void> {
    const owner =
      ownerType === MediaOwnerTypeEnum.PRODUCT
        ? await this.catalogRepository.findById(ownerId)
        : await this.catalogRepository.findVariantById(ownerId);

    if (owner === null) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.MEDIA_OWNER_NOT_FOUND,
        `Media owner ${ownerType} ${ownerId} not found`,
      );
    }
  }
}
