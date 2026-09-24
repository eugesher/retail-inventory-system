import { DeepPartial } from 'typeorm';

import { IIdempotencyRecord, IIdempotencyRecordInput } from '../../application/ports';
import { IdempotencyKeyEntity } from './idempotency-key.entity';

export class IdempotencyKeyMapper {
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
