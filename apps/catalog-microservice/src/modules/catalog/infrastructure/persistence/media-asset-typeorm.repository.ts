import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, FindOptionsWhere, Repository } from 'typeorm';

import { MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';
import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { MediaAsset, MediaAssetStatusEnum } from '../../domain';
import { IMediaAssetRepositoryPort, IMediaListByOwnerOptions } from '../../application/ports';
import { MediaAssetEntity } from './media-asset.entity';
import { MediaAssetMapper } from './media-asset.mapper';

interface IMaxSortOrderRaw {
  max: string | number | null;
}

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
    const raw = await this.mediaRepository
      .createQueryBuilder('media')
      .select('MAX(media.sortOrder)', 'max')
      .where('media.ownerType = :ownerType', { ownerType })
      .andWhere('media.ownerId = :ownerId', { ownerId })
      .getRawOne<IMaxSortOrderRaw>();

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
    await this.mediaRepository.manager.transaction(async (manager) => {
      for (let index = 0; index < orderedIds.length; index += 1) {
        await manager.query(
          'UPDATE media_asset SET sort_order = ? WHERE id = ? AND owner_type = ? AND owner_id = ?',
          [index, orderedIds[index], ownerType, ownerId],
        );
      }
    });

    return this.listByOwner(ownerType, ownerId, { activeOnly: true });
  }

  public async hasActiveForOwners(
    owners: { ownerType: MediaOwnerTypeEnum; ownerId: number }[],
  ): Promise<boolean> {
    if (owners.length === 0) {
      return false;
    }

    const placeholders = owners.map(() => '(?, ?)').join(', ');
    const params: (string | number)[] = [];
    for (const owner of owners) {
      params.push(owner.ownerType, owner.ownerId);
    }
    params.push(MediaAssetStatusEnum.ACTIVE);

    const rows = await this.mediaRepository.query<unknown[]>(
      `SELECT 1 FROM media_asset WHERE (owner_type, owner_id) IN (${placeholders}) AND status = ? LIMIT 1`,
      params,
    );

    return rows.length > 0;
  }
}
