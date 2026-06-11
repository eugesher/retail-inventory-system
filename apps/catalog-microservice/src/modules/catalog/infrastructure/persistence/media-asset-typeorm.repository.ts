import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, FindOptionsWhere, Repository } from 'typeorm';

import { MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';
import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { MediaAsset, MediaAssetStatusEnum } from '../../domain';
import { IMediaAssetRepositoryPort, IMediaListByOwnerOptions } from '../../application/ports';
import { MediaAssetEntity } from './media-asset.entity';
import { MediaAssetMapper } from './media-asset.mapper';

// `MAX(sort_order)` comes back from mysql2 as a string (BIGINT-ish aggregate) or
// null; typed locally so `getRawOne<...>` stays off `any` without an assertion
// (ADR-017's no-unsafe-* rules).
interface IMaxSortOrderRaw {
  max: string | number | null;
}

// The single `InjectRepository` site for the MediaAsset aggregate. Extends
// `BaseTypeormRepository` for the `toDomain`/`toEntity` seam; `save` re-reads for
// the concrete id, and `reorder` runs its own `manager.transaction` (the
// `CategoryTypeormRepository.reparentSubtree` / `PricingTypeormRepository.appendPrice`
// precedent — the transaction lives inside the repository method, no
// `ITransactionPort` needed; ADR-019 / ADR-029).
@Injectable()
export class MediaAssetTypeormRepository
  extends BaseTypeormRepository<MediaAssetEntity, MediaAsset>
  implements IMediaAssetRepositoryPort
{
  constructor(
    @InjectRepository(MediaAssetEntity)
    private readonly mediaRepository: Repository<MediaAssetEntity>,
  ) {
    super(mediaRepository);
  }

  protected toDomain(entity: MediaAssetEntity): MediaAsset {
    return MediaAssetMapper.toDomain(entity);
  }

  protected toEntity(domain: MediaAsset): DeepPartial<MediaAssetEntity> {
    return MediaAssetMapper.toEntity(domain);
  }

  public async save(media: MediaAsset): Promise<MediaAsset> {
    const saved = await this.mediaRepository.save(MediaAssetMapper.toEntity(media));

    // Re-read so the returned aggregate carries the DB-assigned id and timestamps.
    // The row was just committed, so a miss here is an invariant breach.
    const reloaded = await this.findById(saved.id);
    if (!reloaded) {
      throw new Error(`MediaAssetTypeormRepository.save: media ${saved.id} vanished after commit`);
    }
    return reloaded;
  }

  public async findById(id: number): Promise<MediaAsset | null> {
    const entity = await this.mediaRepository.findOne({ where: { id } });
    return entity ? MediaAssetMapper.toDomain(entity) : null;
  }

  public async listByOwner(
    ownerType: MediaOwnerTypeEnum,
    ownerId: number,
    opts?: IMediaListByOwnerOptions,
  ): Promise<MediaAsset[]> {
    const where: FindOptionsWhere<MediaAssetEntity> = { ownerType, ownerId };
    if (opts?.activeOnly) {
      where.status = MediaAssetStatusEnum.ACTIVE;
    }

    // `sortOrder ASC, id ASC` — the owner's render order; `id` is the stable
    // tiebreak when two rows share a slot (only possible across an active /
    // archived boundary, since the active set is a dense permutation post-reorder).
    const entities = await this.mediaRepository.find({
      where,
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
    return entities.map((entity) => MediaAssetMapper.toDomain(entity));
  }

  public async maxSortOrder(
    ownerType: MediaOwnerTypeEnum,
    ownerId: number,
  ): Promise<number | null> {
    // MAX across ALL rows for the owner (archived included), so the default append
    // slot stays monotonic and never collides with an archived row's position.
    const raw = await this.mediaRepository
      .createQueryBuilder('media')
      .select('MAX(media.sortOrder)', 'max')
      .where('media.ownerType = :ownerType', { ownerType })
      .andWhere('media.ownerId = :ownerId', { ownerId })
      .getRawOne<IMaxSortOrderRaw>();

    // No rows → MAX is NULL → no media yet. Otherwise coerce (mysql2 may surface
    // the aggregate as a string).
    const max = raw?.max;
    if (max === null || max === undefined) {
      return null;
    }
    return Number(max);
  }

  public async reorder(
    ownerType: MediaOwnerTypeEnum,
    ownerId: number,
    orderedIds: number[],
  ): Promise<MediaAsset[]> {
    // One transaction for the N slot UPDATEs: a partial apply (some rows moved,
    // some not) would leave the strip in a non-permutation state. The use case has
    // already validated `orderedIds` is an exact permutation of the owner's active
    // set, so each UPDATE matches exactly one row; the `owner_type`/`owner_id`
    // guard in the WHERE is belt-and-braces against a stray id touching another
    // owner. All statements are PARAMETERIZED — `?` placeholders bound by the
    // driver, never string-interpolated (ADR-029).
    await this.mediaRepository.manager.transaction(async (manager) => {
      for (let index = 0; index < orderedIds.length; index += 1) {
        await manager.query(
          'UPDATE media_asset SET sort_order = ? WHERE id = ? AND owner_type = ? AND owner_id = ?',
          [index, orderedIds[index], ownerType, ownerId],
        );
      }
    });

    // Return the refreshed ACTIVE list (now a dense 0..N-1 permutation), sorted.
    return this.listByOwner(ownerType, ownerId, { activeOnly: true });
  }
}
