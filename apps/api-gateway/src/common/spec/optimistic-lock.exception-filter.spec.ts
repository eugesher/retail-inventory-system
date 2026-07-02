import { ArgumentsHost, ConflictException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { OptimisticLockVersionMismatchError, QueryFailedError } from 'typeorm';

import { OptimisticLockExceptionFilter } from '../filters';

// The filter delegates the actual response rendering to `BaseExceptionFilter`. We
// spy on the parent `catch` so the test asserts *what* gets delegated (a remapped
// 409 ConflictException carrying the uniform contract vs. the untouched original)
// without standing up an HTTP adapter — the `DuplicateKeyExceptionFilter` spec
// pattern.
describe('OptimisticLockExceptionFilter', () => {
  const host = {} as ArgumentsHost; // unused once super.catch is stubbed

  let superCatch: jest.SpyInstance;

  beforeEach(() => {
    superCatch = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    superCatch.mockRestore();
  });

  it('remaps an OptimisticLockVersionMismatchError to a 409 with { code: VERSION_MISMATCH, currentVersion }', () => {
    const filter = new OptimisticLockExceptionFilter();
    // Constructor: (entity, expectedVersion, actualVersion). The actual version is
    // the current one the caller should refetch.
    const error = new OptimisticLockVersionMismatchError('StaffUser', 3, 5);

    filter.catch(error, host);

    expect(superCatch).toHaveBeenCalledTimes(1);
    const [delegated] = superCatch.mock.calls[0] as [ConflictException, ArgumentsHost];
    expect(delegated).toBeInstanceOf(ConflictException);
    expect(delegated.getResponse()).toMatchObject({
      statusCode: 409,
      code: 'VERSION_MISMATCH',
      currentVersion: 5,
    });
  });

  it('omits currentVersion when the message carries no parseable actual version', () => {
    const filter = new OptimisticLockExceptionFilter();
    // A Date-versioned entity puts a non-numeric actual version in the message.
    const error = new OptimisticLockVersionMismatchError(
      'StaffUser',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-02-01T00:00:00Z'),
    );

    filter.catch(error, host);

    const [delegated] = superCatch.mock.calls[0] as [ConflictException, ArgumentsHost];
    const body = delegated.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('VERSION_MISMATCH');
    expect(body).not.toHaveProperty('currentVersion');
  });

  it('passes an unrelated error through untouched (defensive branch)', () => {
    const filter = new OptimisticLockExceptionFilter();
    const original = new QueryFailedError('SELECT 1', [], new Error('db error'));

    filter.catch(original, host);

    expect(superCatch).toHaveBeenCalledTimes(1);
    expect(superCatch).toHaveBeenCalledWith(original, host);
  });
});
