import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IReorderMediaPayload, MediaAssetView } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../../domain';
import { IMediaAssetRepositoryPort, MEDIA_ASSET_REPOSITORY } from '../ports';
import { toMediaAssetView } from './media-asset-view.factory';

// Reorder Media re-sequences an owner's media strip in one shot: the new
// `sortOrder` of each asset is its position in `mediaIdsInOrder`. The bulk write
// is ALL-OR-NOTHING — the repository applies every slot UPDATE in one transaction
// (ADR-029 §4). Partial reorder is not a thing, so the use case rejects anything
// that is not an EXACT permutation of the owner's active set before touching the
// repository. Records NO event.
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

    // The current ACTIVE set is the universe of valid ids — a reorder may only
    // permute live media, never an archived (detached) one or a foreign id.
    const active = await this.mediaRepository.listByOwner(ownerType, ownerId, { activeOnly: true });
    const activeIds = new Set(active.map((media) => media.id));

    // Exact-permutation check: same cardinality, no duplicates, every requested id
    // is a member of the active set. Those three together force set equality
    // (|requested| = |active|, requested has no dups, requested ⊆ active ⇒
    // requested = active) — anything else is a `MEDIA_REORDER_SET_MISMATCH` (409),
    // and the repository's `reorder` is never called.
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
