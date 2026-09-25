import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { PurgeAgedDeliveriesUseCase } from '../../../application/use-cases';
import { DeliveryRetentionScheduler } from '../delivery-retention.scheduler';

const SCHEDULE_CRON_OPTIONS = 'SCHEDULE_CRON_OPTIONS';
const SCHEDULER_NAME = 'SCHEDULER_NAME';

const sweepHandler = (): object =>
  Object.getOwnPropertyDescriptor(DeliveryRetentionScheduler.prototype, 'sweep')?.value as object;

class FakePurgeUseCase {
  public readonly execute = jest.fn<Promise<number>, [Date?]>(() => Promise.resolve(0));
}

describe('DeliveryRetentionScheduler', () => {
  let purge: FakePurgeUseCase;
  let logger: PinoLoggerMock;
  let scheduler: DeliveryRetentionScheduler;

  beforeEach(() => {
    purge = new FakePurgeUseCase();
    logger = makePinoLoggerMock();
    scheduler = new DeliveryRetentionScheduler(
      purge as unknown as PurgeAgedDeliveriesUseCase,
      logger as unknown as PinoLogger,
    );
  });

  describe('the schedule', () => {
    it('is registered as a cron, at 03:00, under a stable name', () => {
      const options: unknown = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, sweepHandler());

      expect(options).toEqual({
        name: 'notification-delivery-retention-sweep',
        cronTime: '0 03 * * *',
      });
      expect(Reflect.getMetadata(SCHEDULER_NAME, sweepHandler())).toBe(
        'notification-delivery-retention-sweep',
      );
    });
  });

  describe('the tick', () => {
    it('delegates to the use case, with no arguments', async () => {
      await scheduler.sweep();

      expect(purge.execute).toHaveBeenCalledTimes(1);
      expect(purge.execute).toHaveBeenCalledWith();
    });

    it('reports a rejected sweep by name, at warn, and does not rethrow', async () => {
      purge.execute
        .mockRejectedValueOnce(new Error('ER_LOCK_WAIT_TIMEOUT'))
        .mockResolvedValueOnce(7);

      await expect(scheduler.sweep()).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'ER_LOCK_WAIT_TIMEOUT' },
        'Notification delivery retention sweep failed',
      );

      await expect(scheduler.sweep()).resolves.toBeUndefined();
      expect(purge.execute).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('stringifies a non-Error rejection rather than logging `undefined`', async () => {
      purge.execute.mockRejectedValueOnce('connection reset');

      await scheduler.sweep();

      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'connection reset' },
        'Notification delivery retention sweep failed',
      );
    });

    it('says nothing of its own on a successful sweep', async () => {
      purge.execute.mockResolvedValueOnce(500);

      await scheduler.sweep();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
