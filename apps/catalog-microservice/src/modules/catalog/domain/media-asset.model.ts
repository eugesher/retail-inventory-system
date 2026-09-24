import { MediaAssetTypeEnum, MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { CatalogDomainException, CatalogErrorCodeEnum } from './catalog.exception';
import { MediaAssetStatusEnum } from './media-asset-status.enum';

export interface IMediaAssetProps {
  id: number | null;
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
  uri: string;
  type: MediaAssetTypeEnum;
  altText: string | null;
  sortOrder: number;
  status: MediaAssetStatusEnum;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface ICreateMediaAssetInput {
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
  uri: string;
  type: MediaAssetTypeEnum;
  altText?: string | null;
  sortOrder: number;
}

export class MediaAsset extends AggregateRoot<number | null> {
  private readonly _ownerType: MediaOwnerTypeEnum;
  private readonly _ownerId: number;
  private readonly _uri: string;
  private readonly _type: MediaAssetTypeEnum;
  private readonly _altText: string | null;
  private readonly _sortOrder: number;
  private _status: MediaAssetStatusEnum;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: IMediaAssetProps) {
    if (typeof props.uri !== 'string' || props.uri.trim().length === 0) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.MEDIA_URI_REQUIRED,
        'MediaAsset.uri must be a non-empty string',
      );
    }
    if (!Object.values(MediaOwnerTypeEnum).includes(props.ownerType)) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.MEDIA_OWNER_TYPE_INVALID,
        `MediaAsset.ownerType must be one of ${Object.values(MediaOwnerTypeEnum).join(', ')}`,
      );
    }
    if (!Object.values(MediaAssetTypeEnum).includes(props.type)) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.MEDIA_TYPE_INVALID,
        `MediaAsset.type must be one of ${Object.values(MediaAssetTypeEnum).join(', ')}`,
      );
    }
    if (!Number.isInteger(props.ownerId) || props.ownerId <= 0) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.MEDIA_OWNER_ID_INVALID,
        'MediaAsset.ownerId must be a positive integer',
      );
    }
    if (!Number.isInteger(props.sortOrder) || props.sortOrder < 0) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.MEDIA_SORT_ORDER_INVALID,
        'MediaAsset.sortOrder must be a non-negative integer',
      );
    }

    super(props.id);
    this._ownerType = props.ownerType;
    this._ownerId = props.ownerId;
    this._uri = props.uri;
    this._type = props.type;
    this._altText = props.altText ?? null;
    this._sortOrder = props.sortOrder;
    this._status = props.status;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public static create(input: ICreateMediaAssetInput): MediaAsset {
    return new MediaAsset({
      id: null,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      uri: input.uri,
      type: input.type,
      altText: input.altText ?? null,
      sortOrder: input.sortOrder,
      status: MediaAssetStatusEnum.ACTIVE,
    });
  }

  public static reconstitute(props: IMediaAssetProps): MediaAsset {
    return new MediaAsset(props);
  }

  public get ownerType(): MediaOwnerTypeEnum {
    return this._ownerType;
  }

  public get ownerId(): number {
    return this._ownerId;
  }

  public get uri(): string {
    return this._uri;
  }

  public get type(): MediaAssetTypeEnum {
    return this._type;
  }

  public get altText(): string | null {
    return this._altText;
  }

  public get sortOrder(): number {
    return this._sortOrder;
  }

  public get status(): MediaAssetStatusEnum {
    return this._status;
  }

  public isActive(): boolean {
    return this._status === MediaAssetStatusEnum.ACTIVE;
  }

  public isArchived(): boolean {
    return this._status === MediaAssetStatusEnum.ARCHIVED;
  }

  public archive(): void {
    if (!this.isActive()) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.MEDIA_INVALID_STATE_TRANSITION,
        `MediaAsset.archive: only an active media asset can be archived (current status: ${this._status})`,
      );
    }
    this._status = MediaAssetStatusEnum.ARCHIVED;
  }
}
