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

// `create` takes the human-supplied fields plus the `sortOrder` SLOT the attach
// use case computed (`max(sort_order) + 1` across the owner's media). The caller
// owns the slot arithmetic, not the aggregate — the model only enforces that the
// slot is a non-negative integer.
export interface ICreateMediaAssetInput {
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
  uri: string;
  type: MediaAssetTypeEnum;
  altText?: string | null;
  sortOrder: number;
}

// MediaAsset is a catalog write aggregate (a sibling of `Product` / `Category`,
// inside the same module — not a new bounded context, ADR-029 / ADR-004). It is
// POLYMORPHIC over its owner: `(ownerType, ownerId)` points at EITHER a `product`
// or a single `product-variant` row, with no foreign key (an FK cannot target two
// tables) — owner existence is the use case's job, not a DB constraint (ADR-029
// §4).
//
// `uri` is an OPAQUE, already-uploaded reference (`https://…` / `s3://…`): the
// aggregate validates only that it is non-empty — there is NO scheme allow-list,
// no extension parsing. Upload pipelines, signed URLs, and CDN rewriting are a
// future capability; today the catalog just stores the string a prior upload
// produced.
//
// The `number | null` id mirrors `Product` / `Category`: null before persistence
// assigns one, concrete after `reconstitute`.
//
// Records NO domain events. Like `Category`, media edits are not in the must-emit
// set, so this aggregate never calls `addDomainEvent`; `pullDomainEvents()` always
// drains empty (ADR-029 §6).
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

  // Creates a new `active` media asset at the given slot. The owner reference is
  // taken as-is (the use case has already verified the owner exists — the model
  // cannot see other aggregates). Records no event.
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

  // Rebuilds a persisted media asset from storage — no status guard (any status
  // reconstitutes, including `archived`).
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

  // active → archived status flip (soft-delete via `status`; no `deletedAt`).
  // This is the DETACH operation. It is STATE-GUARDED, NOT idempotent: archiving
  // an already-archived asset is an illegal transition — the row is preserved for
  // anything that captured the id historically, so a second detach is a 409 rather
  // than a silent success (ADR-029 §4).
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
