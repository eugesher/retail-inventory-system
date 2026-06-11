import { MediaOwnerTypeEnum } from '../enums';
import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.media.reorder` (API Gateway →
// Catalog). Re-sequences the owner's media strip in one shot. Carries a
// `correlationId` for log/trace correlation.
//
// `mediaIdsInOrder` is the desired order of the owner's ACTIVE media as an array
// of media ids; the new `sort_order` of each asset is its array index. It must be
// an EXACT permutation of the owner's active set — same ids, no duplicates, no
// omissions, no foreign or archived ids — or the operation is rejected as
// `MEDIA_REORDER_SET_MISMATCH`. Partial reorder is not a thing: the bulk write is
// all-or-nothing (ADR-029 §4).
export interface IReorderMediaPayload extends ICorrelationPayload {
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
  mediaIdsInOrder: number[];
}
