import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { OrderDomainException, OrderErrorCodeEnum } from '../../../domain';
import { OrderWriteConflictError } from '../order-write-conflict.error';
import { runWithOrderWriteRetry } from '../order-write';

describe('runWithOrderWriteRetry', () => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;

  it('retries a lost CAS (OrderWriteConflictError) then succeeds within budget', async () => {
    let attempts = 0;

    const result = await runWithOrderWriteRetry(
      { logger, maxAttempts: 5 },
      () => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.reject(new OrderWriteConflictError(1, 7 + attempts));
        }
        return Promise.resolve('ok');
      },
      { orderId: 1, correlationId: 'corr-1' },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('surfaces 409 VERSION_MISMATCH with details.currentVersion when the budget is exhausted', async () => {
    let attempts = 0;

    await expect(
      runWithOrderWriteRetry(
        { logger, maxAttempts: 3 },
        () => {
          attempts += 1;
          return Promise.reject(new OrderWriteConflictError(1, 42));
        },
        { orderId: 1 },
      ),
    ).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_VERSION_MISMATCH,
      details: { currentVersion: 42 },
    });
    expect(attempts).toBe(3);
  });

  it('the exhaustion error is an OrderDomainException carrying the uniform VERSION_MISMATCH wire value', async () => {
    const error = await runWithOrderWriteRetry(
      { logger, maxAttempts: 1 },
      () => Promise.reject(new OrderWriteConflictError(9, 3)),
      { orderId: 9 },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OrderDomainException);
    expect((error as OrderDomainException).code).toBe('VERSION_MISMATCH');
  });

  it('never retries a terminal domain rejection — it propagates on the first attempt', async () => {
    let attempts = 0;
    const domainError = new OrderDomainException(
      OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
      'fulfillment is not pending',
    );

    await expect(
      runWithOrderWriteRetry({ logger, maxAttempts: 5 }, () => {
        attempts += 1;
        return Promise.reject(domainError);
      }),
    ).rejects.toBe(domainError);
    expect(attempts).toBe(1);
  });
});
