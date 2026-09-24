import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { entityManagerOf } from '@retail-inventory-system/database';

import {
  IDEMPOTENCY_KEY_TTL_HOURS,
  IIdempotencyFinalizeInput,
  IIdempotencyRecord,
  IIdempotencyRecordInput,
  IIdempotencyReservation,
  IIdempotencyReserveInput,
  IIdempotencyStorePort,
  ITransactionScope,
} from '../../application/ports';
import { IdempotencyKeyEntity } from './idempotency-key.entity';
import { IdempotencyKeyMapper } from './idempotency-key.mapper';

const MYSQL_ER_DUP_ENTRY_ERRNO = 1062;
const MYSQL_ER_DUP_ENTRY_CODE = 'ER_DUP_ENTRY';

function isDuplicateEntryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    errno?: number;
    code?: string;
    driverError?: { errno?: number; code?: string };
  };
  const driver = candidate.driverError ?? candidate;
  return driver.errno === MYSQL_ER_DUP_ENTRY_ERRNO || driver.code === MYSQL_ER_DUP_ENTRY_CODE;
}

const MS_PER_HOUR = 60 * 60 * 1000;

@Injectable()
export class IdempotencyStoreTypeormRepository implements IIdempotencyStorePort {
  constructor(
    @InjectRepository(IdempotencyKeyEntity)
    private readonly idempotencyKeyRepository: Repository<IdempotencyKeyEntity>,
    @Inject(IDEMPOTENCY_KEY_TTL_HOURS)
    private readonly ttlHours: number,
  ) {}

  public async find(scope: string, key: string): Promise<IIdempotencyRecord | null> {
    const entity = await this.idempotencyKeyRepository.findOne({ where: { scope, key } });
    if (!entity) {
      return null;
    }
    if (entity.responseBody === null) {
      return null;
    }
    return IdempotencyKeyMapper.toDomain(entity);
  }

  public async save(record: IIdempotencyRecordInput, scope?: ITransactionScope): Promise<void> {
    const expiresAt = new Date(Date.now() + this.ttlHours * MS_PER_HOUR);
    const partial = IdempotencyKeyMapper.toEntity(record, expiresAt);

    try {
      await this.idempotencyRepo(scope).insert(
        partial as QueryDeepPartialEntity<IdempotencyKeyEntity>,
      );
    } catch (error) {
      if (isDuplicateEntryError(error)) {
        return;
      }
      throw error;
    }
  }

  public async deleteExpired(now: Date): Promise<number> {
    const result = await this.idempotencyKeyRepository.delete({ expiresAt: LessThan(now) });
    return result.affected ?? 0;
  }

  public async reserve(
    input: IIdempotencyReserveInput,
    scope?: ITransactionScope,
  ): Promise<IIdempotencyReservation> {
    const expiresAt = new Date(Date.now() + this.ttlHours * MS_PER_HOUR);
    const pending: QueryDeepPartialEntity<IdempotencyKeyEntity> = {
      scope: input.scope,
      key: input.key,
      requestFingerprint: input.requestFingerprint,
      responseStatus: null,
      responseBody: null,
      expiresAt,
    };

    try {
      await this.idempotencyRepo(scope).insert(pending);
      return { outcome: 'reserved' };
    } catch (error) {
      if (!isDuplicateEntryError(error)) {
        throw error;
      }
    }

    const existing = await this.idempotencyKeyRepository.findOne({
      where: { scope: input.scope, key: input.key },
    });
    if (!existing) {
      return { outcome: 'in-progress' };
    }
    if (existing.requestFingerprint !== input.requestFingerprint) {
      return { outcome: 'mismatch' };
    }
    if (existing.responseBody === null) {
      return { outcome: 'in-progress' };
    }
    return { outcome: 'replay', record: IdempotencyKeyMapper.toDomain(existing) };
  }

  public async finalize(
    input: IIdempotencyFinalizeInput,
    scope?: ITransactionScope,
  ): Promise<void> {
    const completion = {
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
    } as QueryDeepPartialEntity<IdempotencyKeyEntity>;
    await this.idempotencyRepo(scope).update({ scope: input.scope, key: input.key }, completion);
  }

  public async release(scope: string, key: string): Promise<void> {
    await this.idempotencyKeyRepository.delete({ scope, key, responseBody: IsNull() });
  }

  private idempotencyRepo(scope?: ITransactionScope): Repository<IdempotencyKeyEntity> {
    if (!scope) {
      return this.idempotencyKeyRepository;
    }
    return entityManagerOf(scope).getRepository(IdempotencyKeyEntity);
  }
}
