import { DeepPartial } from 'typeorm';

import { IIdempotencyRecord, IIdempotencyRecordInput } from '../../application/ports';
import { IdempotencyKeyEntity } from './idempotency-key.entity';

export class IdempotencyKeyMapper {
  // Maps a COMPLETED row to a replayable record. The repository only calls this for a
  // finalized row (`find` returns null for a pending one, `reserve` maps only the
  // `replay` case), so the nullable `response_status` / `response_body` columns are
  // non-null here — the reserve-first pending row (ADR-036) is never mapped to a record.
  public static toDomain(entity: IdempotencyKeyEntity): IIdempotencyRecord {
    return {
      scope: entity.scope,
      key: entity.key,
      requestFingerprint: entity.requestFingerprint,
      responseStatus: entity.responseStatus!,
      responseBody: entity.responseBody!,
      createdAt: entity.createdAt,
      expiresAt: entity.expiresAt,
    };
  }

  // The INSERT row. `created_at` is omitted — it is DB-defaulted to the row's birth.
  // `expires_at` is computed by the repository from the injected TTL and threaded in
  // here, so the mapper stays a pure column projection with no clock or config of its
  // own. There is no update path: a stored-response row is immutable once written.
  public static toEntity(
    input: IIdempotencyRecordInput,
    expiresAt: Date,
  ): DeepPartial<IdempotencyKeyEntity> {
    return {
      scope: input.scope,
      key: input.key,
      requestFingerprint: input.requestFingerprint,
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
      expiresAt,
    };
  }
}
