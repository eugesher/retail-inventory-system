import { MediaOwnerTypeEnum } from '../enums';
import { ICorrelationPayload } from '../../microservices';

// Wire-format query payload for `catalog.media.list` (API Gateway → Catalog).
// Lists the ACTIVE media for one owner, ordered by `sortOrder`. Carries a
// `correlationId` for log/trace correlation.
//
// One query serves BOTH the product- and variant-scoped gateway GETs — the
// `ownerType` discriminator selects which. There is NO owner-existence probe: an
// unknown owner yields `[]`, the public-browse zero-answer convention (a 404 here
// would force every storefront render into error handling — ADR-029 §4).
export interface IMediaListQuery extends ICorrelationPayload {
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
}
