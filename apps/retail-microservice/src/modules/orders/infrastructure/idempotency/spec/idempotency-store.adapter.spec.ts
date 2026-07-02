import { LessThan, Repository } from 'typeorm';

import { IIdempotencyRecordInput, ITransactionScope } from '../../../application/ports';
import { IdempotencyKeyEntity } from '../idempotency-key.entity';
import { IdempotencyKeyMapper } from '../idempotency-key.mapper';
import { IdempotencyStoreTypeormRepository } from '../idempotency-store.typeorm.repository';

const TTL_HOURS = 24;

// A persisted idempotency row, used as the `find` re-read. `response_body` is the JSON
// column TypeORM serializes/deserializes — the round-trip test asserts it survives
// verbatim.
const keyEntity = (overrides: Partial<IdempotencyKeyEntity> = {}): IdempotencyKeyEntity =>
  ({
    scope: 'place-order',
    key: 'client-key-abc',
    requestFingerprint: 'a'.repeat(64),
    responseStatus: 201,
    responseBody: { orderId: 7, total: { amountMinor: 5997, currency: 'USD' } },
    createdAt: new Date('2026-06-30T10:00:00Z'),
    expiresAt: new Date('2026-07-01T10:00:00Z'),
    ...overrides,
  }) as IdempotencyKeyEntity;

const recordInput = (
  overrides: Partial<IIdempotencyRecordInput> = {},
): IIdempotencyRecordInput => ({
  scope: 'place-order',
  key: 'client-key-abc',
  requestFingerprint: 'a'.repeat(64),
  responseStatus: 201,
  responseBody: { orderId: 7, total: { amountMinor: 5997, currency: 'USD' } },
  ...overrides,
});

// MySQL ER_DUP_ENTRY shaped two ways the duck-typed guard must catch — the flat driver
// error and the TypeORM-nested `driverError`.
const dupErrorFlat = (): unknown => ({ code: 'ER_DUP_ENTRY', errno: 1062 });
const dupErrorNested = (): unknown => ({ driverError: { code: 'ER_DUP_ENTRY', errno: 1062 } });

describe('IdempotencyKeyMapper', () => {
  it('round-trips a stored-response row, preserving the status and the JSON body verbatim', () => {
    const record = IdempotencyKeyMapper.toDomain(keyEntity());

    expect(record.scope).toBe('place-order');
    expect(record.key).toBe('client-key-abc');
    expect(record.requestFingerprint).toBe('a'.repeat(64));
    expect(record.responseStatus).toBe(201);
    expect(record.responseBody).toEqual({
      orderId: 7,
      total: { amountMinor: 5997, currency: 'USD' },
    });
    expect(record.createdAt).toEqual(new Date('2026-06-30T10:00:00Z'));
    expect(record.expiresAt).toEqual(new Date('2026-07-01T10:00:00Z'));
  });

  it('omits created_at on the insert row (DB-defaulted) and threads in the computed expires_at', () => {
    const expiresAt = new Date('2026-07-01T10:00:00Z');
    const partial = IdempotencyKeyMapper.toEntity(recordInput(), expiresAt);

    expect('createdAt' in partial).toBe(false);
    expect(partial.expiresAt).toEqual(expiresAt);
    expect(partial.responseStatus).toBe(201);
  });
});

describe('IdempotencyStoreTypeormRepository', () => {
  let keyRepo: jest.Mocked<Pick<Repository<IdempotencyKeyEntity>, 'findOne' | 'insert' | 'delete'>>;
  let repository: IdempotencyStoreTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    keyRepo = { findOne: jest.fn(), insert: jest.fn(), delete: jest.fn() } as never;
    repository = new IdempotencyStoreTypeormRepository(
      keyRepo as unknown as Repository<IdempotencyKeyEntity>,
      TTL_HOURS,
    );
  });

  describe('find', () => {
    it('returns the mapped record when a row matches (scope + key)', async () => {
      keyRepo.findOne.mockResolvedValue(keyEntity());

      const result = await repository.find('place-order', 'client-key-abc');

      expect(keyRepo.findOne).toHaveBeenCalledWith({
        where: { scope: 'place-order', key: 'client-key-abc' },
      });
      expect(result?.responseStatus).toBe(201);
      expect(result?.responseBody).toEqual({
        orderId: 7,
        total: { amountMinor: 5997, currency: 'USD' },
      });
    });

    it('returns null when no row matches the (scope, key)', async () => {
      keyRepo.findOne.mockResolvedValue(null);

      await expect(repository.find('place-order', 'absent-key')).resolves.toBeNull();
    });

    it('does NOT filter by expiry — a past-expires_at row is still returned (the sweeper removes it)', async () => {
      keyRepo.findOne.mockResolvedValue(keyEntity({ expiresAt: new Date('2000-01-01T00:00:00Z') }));

      const result = await repository.find('place-order', 'client-key-abc');

      // No expiry predicate in the where-clause; the row comes back regardless.
      expect(keyRepo.findOne).toHaveBeenCalledWith({
        where: { scope: 'place-order', key: 'client-key-abc' },
      });
      expect(result).not.toBeNull();
    });

    it('treats the same key under two scopes as independent rows', async () => {
      keyRepo.findOne
        .mockResolvedValueOnce(keyEntity({ scope: 'place-order', responseStatus: 201 }))
        .mockResolvedValueOnce(keyEntity({ scope: 'capture-payment', responseStatus: 200 }));

      const place = await repository.find('place-order', 'shared-key');
      const capture = await repository.find('capture-payment', 'shared-key');

      expect(place?.responseStatus).toBe(201);
      expect(capture?.responseStatus).toBe(200);
      expect(keyRepo.findOne).toHaveBeenNthCalledWith(1, {
        where: { scope: 'place-order', key: 'shared-key' },
      });
      expect(keyRepo.findOne).toHaveBeenNthCalledWith(2, {
        where: { scope: 'capture-payment', key: 'shared-key' },
      });
    });
  });

  describe('save', () => {
    it('inserts the row with expires_at = now + IDEMPOTENCY_KEY_TTL_HOURS', async () => {
      const before = Date.now();
      keyRepo.insert.mockResolvedValue({} as never);

      await repository.save(recordInput());

      expect(keyRepo.insert).toHaveBeenCalledTimes(1);
      const inserted = keyRepo.insert.mock.calls[0][0] as Partial<IdempotencyKeyEntity>;
      expect(inserted.scope).toBe('place-order');
      expect(inserted.key).toBe('client-key-abc');
      expect(inserted.responseStatus).toBe(201);
      // The horizon is `now + 24h`, within a tolerance band around the call.
      const expiresMs = inserted.expiresAt!.getTime();
      expect(expiresMs).toBeGreaterThanOrEqual(before + TTL_HOURS * 3600_000);
      expect(expiresMs).toBeLessThanOrEqual(Date.now() + TTL_HOURS * 3600_000);
    });

    it('swallows a duplicate-PK insert as a no-op (flat driver error) — the concurrent-first-writer race', async () => {
      keyRepo.insert.mockRejectedValue(dupErrorFlat());

      await expect(repository.save(recordInput())).resolves.toBeUndefined();
    });

    it('swallows a duplicate-PK insert nested under driverError', async () => {
      keyRepo.insert.mockRejectedValue(dupErrorNested());

      await expect(repository.save(recordInput())).resolves.toBeUndefined();
    });

    it('rethrows any non-duplicate insert failure', async () => {
      keyRepo.insert.mockRejectedValue(new Error('connection reset'));

      await expect(repository.save(recordInput())).rejects.toThrow('connection reset');
    });

    it('routes the insert through the caller transaction when a scope is supplied', async () => {
      const scopedRepo = { insert: jest.fn().mockResolvedValue({}) };
      const getRepository = jest.fn().mockReturnValue(scopedRepo);
      const scope = { getRepository } as unknown as ITransactionScope;

      await repository.save(recordInput(), scope);

      expect(getRepository).toHaveBeenCalledWith(IdempotencyKeyEntity);
      expect(scopedRepo.insert).toHaveBeenCalledTimes(1);
      // The default-manager repo was bypassed.
      expect(keyRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('deleteExpired', () => {
    it('deletes rows with expires_at < now and returns the affected count', async () => {
      const now = new Date('2026-07-01T12:00:00Z');
      keyRepo.delete.mockResolvedValue({ affected: 3, raw: {} } as never);

      const removed = await repository.deleteExpired(now);

      expect(removed).toBe(3);
      // The bounded range predicate — a strict `expires_at < now`, scanning the index.
      expect(keyRepo.delete).toHaveBeenCalledWith({ expiresAt: LessThan(now) });
    });

    it('coalesces a missing affected count (driver-dependent) to 0', async () => {
      keyRepo.delete.mockResolvedValue({ raw: {} } as never);

      await expect(repository.deleteExpired(new Date())).resolves.toBe(0);
    });
  });
});
