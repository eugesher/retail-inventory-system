import { MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';

import { MediaAsset } from '../../domain';

export const MEDIA_ASSET_REPOSITORY = Symbol('MEDIA_ASSET_REPOSITORY');

export interface IMediaListByOwnerOptions {
  activeOnly?: boolean;
}

export interface IMediaAssetRepositoryPort {
  save(media: MediaAsset): Promise<MediaAsset>;
  findById(id: number): Promise<MediaAsset | null>;
  listByOwner(
    ownerType: MediaOwnerTypeEnum,
    ownerId: number,
    opts?: IMediaListByOwnerOptions,
  ): Promise<MediaAsset[]>;
  maxSortOrder(ownerType: MediaOwnerTypeEnum, ownerId: number): Promise<number | null>;
  reorder(
    ownerType: MediaOwnerTypeEnum,
    ownerId: number,
    orderedIds: number[],
  ): Promise<MediaAsset[]>;
  hasActiveForOwners(
    owners: { ownerType: MediaOwnerTypeEnum; ownerId: number }[],
  ): Promise<boolean>;
}
