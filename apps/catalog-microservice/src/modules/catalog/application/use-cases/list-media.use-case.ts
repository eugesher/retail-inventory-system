import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IMediaListQuery, MediaAssetView } from '@retail-inventory-system/contracts';

import { IMediaAssetRepositoryPort, MEDIA_ASSET_REPOSITORY } from '../ports';
import { toMediaAssetView } from './media-asset-view.factory';

// List Media returns an owner's ACTIVE media, `sortOrder ASC`. One query serves
// both the product- and variant-scoped reads (the `ownerType` discriminator
// selects which). There is NO owner-existence probe: an unknown owner yields `[]`
// — the public-browse zero-answer convention the inventory per-variant stock read
// set, because a 404 here would force every storefront render into error handling
// (ADR-029 §4).
@Injectable()
export class ListMediaUseCase {
  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly mediaRepository: IMediaAssetRepositoryPort,
    @InjectPinoLogger(ListMediaUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: IMediaListQuery): Promise<MediaAssetView[]> {
    const { ownerType, ownerId, correlationId } = query;

    this.logger.info({ correlationId, ownerType, ownerId }, 'Received RPC: list media');

    const media = await this.mediaRepository.listByOwner(ownerType, ownerId, { activeOnly: true });

    return media.map(toMediaAssetView);
  }
}
