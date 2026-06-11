import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.media.detach` (API Gateway →
// Catalog). Detaches a single media asset addressed by its own `mediaId` —
// independent of its owner, since the id is globally unique. Carries a
// `correlationId` for log/trace correlation.
//
// Detach is a STATUS FLIP (`active → archived`), not a row delete: the row
// survives so anything that captured the id historically still resolves it
// (ADR-029 §4). It is state-guarded, not idempotent — a second detach of an
// already-archived asset is `MEDIA_INVALID_STATE_TRANSITION`.
export interface IDetachMediaPayload extends ICorrelationPayload {
  mediaId: number;
}
