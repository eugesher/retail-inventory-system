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

// Attach Media is the first media write operation: it appends a new `active`
// media asset to a product or a single product variant. Because the polymorphic
// owner carries NO foreign key (ADR-029 §4), the use case is the ONLY guard that
// the owner exists — it probes the right table by `ownerType`. The new asset lands
// at the END of the owner's strip (`max(sort_order) + 1`), so attach order is
// preservation order until an explicit reorder. Records NO event.
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

    // Owner existence — the compensation for the missing polymorphic FK. A product
    // owner resolves through `findById`, a variant owner through `findVariantById`;
    // a miss is a 404. An ARCHIVED owner is still a valid target (archived stays
    // resolvable — ADR-025; no extra rule).
    await this.assertOwnerExists(ownerType, ownerId);

    // Append slot: the first asset lands at 0, subsequent attaches go to the end.
    // `maxSortOrder` counts ARCHIVED rows too, so a detached asset's slot is never
    // reused — the strip's slots stay monotonic.
    const maxSortOrder = await this.mediaRepository.maxSortOrder(ownerType, ownerId);
    const sortOrder = (maxSortOrder ?? -1) + 1;

    // Build — the aggregate enforces the uri/owner/type/sort-order invariants,
    // throwing a typed `CatalogDomainException` on a violation.
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

  // Probes the owner's existence against the table its `ownerType` names. Throws
  // `MEDIA_OWNER_NOT_FOUND` (404) on a miss.
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
