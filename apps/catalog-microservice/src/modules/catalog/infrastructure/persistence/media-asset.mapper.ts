import { DeepPartial } from 'typeorm';

import { MediaAsset } from '../../domain';
import { MediaAssetEntity } from './media-asset.entity';

export class MediaAssetMapper {
  public static toEntity(domain: MediaAsset): DeepPartial<MediaAssetEntity> {
    const entity: DeepPartial<MediaAssetEntity> = {
      ownerType: domain.ownerType,
      ownerId: domain.ownerId,
      uri: domain.uri,
      type: domain.type,
      altText: domain.altText,
      sortOrder: domain.sortOrder,
      status: domain.status,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: MediaAssetEntity): MediaAsset {
    return MediaAsset.reconstitute({
      id: entity.id,
      ownerType: entity.ownerType,
      ownerId: Number(entity.ownerId),
      uri: entity.uri,
      type: entity.type,
      altText: entity.altText ?? null,
      sortOrder: entity.sortOrder,
      status: entity.status,
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
