import { Column, Entity, Index } from 'typeorm';

import { MediaAssetTypeEnum, MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { MediaAssetStatusEnum } from '../../domain';

@Entity('media_asset')
@Index('IDX_MEDIA_ASSET_OWNER', ['ownerType', 'ownerId', 'sortOrder'])
export class MediaAssetEntity extends BaseEntity {
  @Column({ type: 'enum', enum: MediaOwnerTypeEnum })
  public ownerType: MediaOwnerTypeEnum;

  @Column({ type: 'bigint', unsigned: true })
  public ownerId: number;

  @Column({ type: 'varchar', length: 1024 })
  public uri: string;

  @Column({ type: 'enum', enum: MediaAssetTypeEnum })
  public type: MediaAssetTypeEnum;

  @Column({ type: 'varchar', length: 255, nullable: true })
  public altText: string | null;

  @Column({ type: 'int', default: 0 })
  public sortOrder: number;

  @Column({ type: 'enum', enum: MediaAssetStatusEnum, default: MediaAssetStatusEnum.ACTIVE })
  public status: MediaAssetStatusEnum;
}
