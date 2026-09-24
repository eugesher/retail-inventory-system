import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReportStaleCaptureClaimsUseCase } from '../../../application/use-cases';
import { StaleCaptureClaimScheduler } from '../stale-capture-claim.scheduler';

const SCHEDULE_CRON_OPTIONS = 'SCHEDULE_CRON_OPTIONS';
const SCHEDULER_NAME = 'SCHEDULER_NAME';

const sweepHandler = (): object =>
  Object.getOwnPropertyDescriptor(StaleCaptureClaimScheduler.prototype, 'sweep')?.value as object;

class FakeReportUseCase {
  public readonly execute = jest.fn<Promise<number>, [Date?]>(() => Promise.resolve(0));
}

describe('StaleCaptureClaimScheduler', () => {
  let report: FakeReportUseCase;
  let logger: PinoLoggerMock;
  let scheduler: StaleCaptureClaimScheduler;

  beforeEach(() => {
    report = new FakeReportUseCase();
    logger = makePinoLoggerMock();
    scheduler = new StaleCaptureClaimScheduler(
      report as unknown as ReportStaleCaptureClaimsUseCase,
      logger as unknown as PinoLogger,
    );
  });

  describe('the schedule', () => {
    it('is registered as a cron, every ten minutes, under a stable name', () => {
      const options: unknown = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, sweepHandler());

      expect(options).toEqual({ name: 'stale-capture-claim-report', cronTime: '0 */10 * * * *' });
      expect(Reflect.getMetadata(SCHEDULER_NAME, sweepHandler())).toBe(
        'stale-capture-claim-report',
      );
    });
  });

  describe('the tick', () => {
    it('delegates to the use case, with no arguments', async () => {
      await scheduler.sweep();

      expect(report.execute).toHaveBeenCalledTimes(1);
      expect(report.execute).toHaveBeenCalledWith();
    });

    it('reports a rejected sweep by name, at warn, and does not rethrow', async () => {
      report.execute
        .mockRejectedValueOnce(new Error('ER_LOCK_WAIT_TIMEOUT'))
        .mockResolvedValueOnce(2);

      await expect(scheduler.sweep()).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'ER_LOCK_WAIT_TIMEOUT' },
        'Stale capture claim report failed',
      );

      await expect(scheduler.sweep()).resolves.toBeUndefined();
      expect(report.execute).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('stringifies a non-Error rejection rather than logging `undefined`', async () => {
      report.execute.mockRejectedValueOnce('connection reset');

      await scheduler.sweep();

      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'connection reset' },
        'Stale capture claim report failed',
      );
    });

    it('does not act on the reported rows — a found claim is still only a log line', async () => {
      report.execute.mockResolvedValueOnce(3);

      await scheduler.sweep();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(report.execute).toHaveBeenCalledTimes(1);
    });
  });
});
