import { ArgumentsHost, ConflictException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { QueryFailedError } from 'typeorm';

import { DuplicateKeyExceptionFilter } from '../duplicate-key-exception.filter';

// The filter delegates the actual response rendering to `BaseExceptionFilter`.
// We spy on the parent `catch` so the test asserts *what* gets delegated (a
// remapped ConflictException vs. the untouched original) without standing up an
// HTTP adapter.
describe('DuplicateKeyExceptionFilter', () => {
  const host = {} as ArgumentsHost; // unused once super.catch is stubbed

  const queryFailedWith = (driverError: unknown): QueryFailedError => {
    const error = new QueryFailedError('INSERT ...', [], new Error('db error'));
    (error as unknown as { driverError: unknown }).driverError = driverError;
    return error;
  };

  let superCatch: jest.SpyInstance;

  beforeEach(() => {
    superCatch = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    superCatch.mockRestore();
  });

  it('remaps a MySQL duplicate-entry (errno 1062) to a 409 ConflictException', () => {
    const filter = new DuplicateKeyExceptionFilter();

    filter.catch(queryFailedWith({ errno: 1062, code: 'ER_DUP_ENTRY' }), host);

    expect(superCatch).toHaveBeenCalledTimes(1);
    expect(superCatch).toHaveBeenCalledWith(expect.any(ConflictException), host);
  });

  it('remaps when only the string code ER_DUP_ENTRY is present', () => {
    const filter = new DuplicateKeyExceptionFilter();

    filter.catch(queryFailedWith({ code: 'ER_DUP_ENTRY' }), host);

    expect(superCatch).toHaveBeenCalledWith(expect.any(ConflictException), host);
  });

  it('passes a non-duplicate QueryFailedError through untouched (still a 500)', () => {
    const filter = new DuplicateKeyExceptionFilter();
    const original = queryFailedWith({ errno: 1213, code: 'ER_LOCK_DEADLOCK' });

    filter.catch(original, host);

    expect(superCatch).toHaveBeenCalledTimes(1);
    expect(superCatch).toHaveBeenCalledWith(original, host);
  });
});
