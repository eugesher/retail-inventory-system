import { ITransactionScope } from '@retail-inventory-system/ddd';

export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

export interface IIdempotencyRecord {
  readonly scope: string;
  readonly key: string;
  readonly requestFingerprint: string;
  readonly responseStatus: number;
  readonly responseBody: Record<string, unknown>;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface IIdempotencyRecordInput {
  readonly scope: string;
  readonly key: string;
  readonly requestFingerprint: string;
  readonly responseStatus: number;
  readonly responseBody: Record<string, unknown>;
}

export interface IIdempotencyReserveInput {
  readonly scope: string;
  readonly key: string;
  readonly requestFingerprint: string;
}

export interface IIdempotencyFinalizeInput {
  readonly scope: string;
  readonly key: string;
  readonly responseStatus: number;
  readonly responseBody: Record<string, unknown>;
}

export interface IIdempotencyReservation {
  readonly outcome: 'reserved' | 'replay' | 'in-progress' | 'mismatch';
  readonly record?: IIdempotencyRecord;
}

export interface IIdempotencyStorePort {
  find(scope: string, key: string): Promise<IIdempotencyRecord | null>;

  save(record: IIdempotencyRecordInput, scope?: ITransactionScope): Promise<void>;

  deleteExpired(now: Date): Promise<number>;

  reserve(
    input: IIdempotencyReserveInput,
    scope?: ITransactionScope,
  ): Promise<IIdempotencyReservation>;

  finalize(input: IIdempotencyFinalizeInput, scope?: ITransactionScope): Promise<void>;

  release(scope: string, key: string): Promise<void>;
}
