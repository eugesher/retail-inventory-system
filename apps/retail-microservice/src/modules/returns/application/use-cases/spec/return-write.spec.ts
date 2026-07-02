import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReturnDomainException, ReturnErrorCodeEnum } from '../../../domain';
import { ReturnWriteConflictError } from '../return-write-conflict.error';
import { runWithReturnWriteRetry } from '../return-write';

// Pure unit test of the shared bounded return-write retry protocol (ADR-036) — the
// mechanism every version-checked RMA lifecycle transition (authorize / reject /
// receive / inspect / close) wraps its write in. Proves: a lost CAS retries then
// succeeds; an exhausted budget surfaces the uniform `409 VERSION_MISMATCH` with
// `details.currentVersion`; a terminal domain rejection is NOT retried.
describe('runWithReturnWriteRetry', () => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;

  it('retries a lost CAS (ReturnWriteConflictError) then succeeds within budget', async () => {
    let attempts = 0;

    const result = await runWithReturnWriteRetry(
      { logger, maxAttempts: 5 },
      () => {
        attempts += 1;
        if (attempts < 2) {
          return Promise.reject(new ReturnWriteConflictError(3, 1 + attempts));
        }
        return Promise.resolve('ok');
      },
      { rmaId: 3, correlationId: 'corr-1' },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('surfaces 409 VERSION_MISMATCH with details.currentVersion when the budget is exhausted', async () => {
    let attempts = 0;

    await expect(
      runWithReturnWriteRetry(
        { logger, maxAttempts: 4 },
        () => {
          attempts += 1;
          return Promise.reject(new ReturnWriteConflictError(3, 11));
        },
        { rmaId: 3 },
      ),
    ).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_VERSION_MISMATCH,
      details: { currentVersion: 11 },
    });
    expect(attempts).toBe(4);
  });

  it('the exhaustion error is a ReturnDomainException carrying the uniform VERSION_MISMATCH wire value', async () => {
    const error = await runWithReturnWriteRetry(
      { logger, maxAttempts: 1 },
      () => Promise.reject(new ReturnWriteConflictError(3, 2)),
      { rmaId: 3 },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReturnDomainException);
    expect((error as ReturnDomainException).code).toBe('VERSION_MISMATCH');
  });

  it('never retries a terminal domain rejection — it propagates on the first attempt', async () => {
    let attempts = 0;
    const domainError = new ReturnDomainException(
      ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION,
      'not in the required status',
    );

    await expect(
      runWithReturnWriteRetry({ logger, maxAttempts: 5 }, () => {
        attempts += 1;
        return Promise.reject(domainError);
      }),
    ).rejects.toBe(domainError);
    expect(attempts).toBe(1);
  });
});
