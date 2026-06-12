import { MediaAssetTypeEnum, MediaOwnerTypeEnum } from '../enums';
import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.media.attach` (API Gateway →
// Catalog). Attaches a new media asset to the owner identified by
// `(ownerType, ownerId)`. Carries a `correlationId` for log/trace correlation.
//
// The owner is addressed by its BIGINT `id` (not a slug): media is attached by an
// operator already holding the product/variant id, and the use case probes that
// id against the matching table for existence (a miss → `MEDIA_OWNER_NOT_FOUND`).
// `uri` is an opaque, already-uploaded reference — no scheme/extension is parsed
// (ADR-029 §4). `altText` is optional accessibility text. There is NO `sortOrder`
// field: the attach use case appends, computing `max(sort_order) + 1` for the
// owner, so the caller cannot pick a slot (reordering is the separate
// `catalog.media.reorder` operation).
export interface IAttachMediaPayload extends ICorrelationPayload {
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
  uri: string;
  type: MediaAssetTypeEnum;
  altText?: string;
}
