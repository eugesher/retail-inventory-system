import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { PurgeExpiredIdempotencyKeysUseCase } from '../purge-expired-idempotency-keys.use-case';
import { buildIdempotencyRecord, FakeIdempotencyStore } from './test-doubles';

// The TTL purge (ADR-036). The store is live-ephemeral — `find` never filters by expiry,
// so this sweep is the sole deleter of a row past its `expires_at`. The `deleteExpired(now)`
// seam takes an explicit instant so a test can pin the clock and force a deterministic
// deletion (the same seam the concurrency e2e uses to "advance time" without touching the
// system clock). The in-memory `FakeIdempotencyStore` mirrors the adapter's bounded
// `DELETE … WHERE expires_at < now`.
describe('PurgeExpiredIdempotencyKeysUseCase', () => {
  let store: FakeIdempotencyStore;
  let logger: PinoLoggerMock;
  let useCase: PurgeExpiredIdempotencyKeysUseCase;

  beforeEach(() => {
    store = new FakeIdempotencyStore();
    logger = makePinoLoggerMock();
    useCase = new PurgeExpiredIdempotencyKeysUseCase(store, logger as unknown as PinoLogger);
  });

  it('deletes a past-expiry row, retains a future one, and returns the deleted count', async () => {
    store.seed(
      buildIdempotencyRecord({ key: 'expired', expiresAt: new Date('2026-06-11T00:00:00.000Z') }),
    );
    store.seed(
      buildIdempotencyRecord({ key: 'live', expiresAt: new Date('2026-06-12T00:00:00.000Z') }),
    );

    // `now` sits between the two horizons: the first row has expired, the second has not.
    const deleted = await useCase.execute(new Date('2026-06-11T12:00:00.000Z'));

    expect(deleted).toBe(1);
    await expect(store.find('place-order', 'expired')).resolves.toBeNull();
    await expect(store.find('place-order', 'live')).resolves.not.toBeNull();
  });

  it('retains a row whose expires_at is exactly now (strict < boundary)', async () => {
    const boundary = new Date('2026-06-11T00:00:00.000Z');
    store.seed(buildIdempotencyRecord({ key: 'boundary', expiresAt: boundary }));

    const deleted = await useCase.execute(boundary);

    expect(deleted).toBe(0);
    await expect(store.find('place-order', 'boundary')).resolves.not.toBeNull();
  });

  it('returns 0 and logs at debug (not info) when nothing has expired', async () => {
    store.seed(
      buildIdempotencyRecord({ key: 'live', expiresAt: new Date('2026-06-12T00:00:00.000Z') }),
    );

    const deleted = await useCase.execute(new Date('2026-06-11T00:00:00.000Z'));

    expect(deleted).toBe(0);
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logs the purged count at info when rows are deleted', async () => {
    store.seed(
      buildIdempotencyRecord({ key: 'expired', expiresAt: new Date('2026-06-01T00:00:00.000Z') }),
    );

    await useCase.execute(new Date('2026-06-11T00:00:00.000Z'));

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 1 }),
      expect.any(String),
    );
  });

  it('defaults now to the wall clock when invoked with no argument (the scheduler path)', async () => {
    // A long-past horizon is swept regardless of the exact wall-clock instant.
    store.seed(
      buildIdempotencyRecord({ key: 'ancient', expiresAt: new Date('2000-01-01T00:00:00.000Z') }),
    );

    const deleted = await useCase.execute();

    expect(deleted).toBe(1);
  });
});
