import { SchedulerRegistry } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';

import { IReservationSweepResult } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { SweepExpiredReservationsUseCase } from '../../../application/use-cases';
import {
  RESERVATION_SWEEP_INTERVAL_NAME,
  ReservationSweepScheduler,
} from '../reservation-sweep.scheduler';

const INTERVAL_SECONDS = 2;
const INTERVAL_MS = INTERVAL_SECONDS * 1000;

const EMPTY_SWEEP: IReservationSweepResult = {
  scanned: 0,
  expired: 0,
  skipped: 0,
  durationMs: 0,
};

// A stand-in for the use case: the scheduler only ever calls `execute()` with no arguments,
// so the double needs nothing else. The real `SchedulerRegistry` is used as-is — it is a
// plain class with a no-arg constructor and a `Map` behind it.
class FakeSweepUseCase {
  public readonly execute = jest.fn<Promise<IReservationSweepResult>, []>(() =>
    Promise.resolve(EMPTY_SWEEP),
  );
}

describe('ReservationSweepScheduler', () => {
  let registry: SchedulerRegistry;
  let sweeper: FakeSweepUseCase;
  let logger: PinoLoggerMock;
  let scheduler: ReservationSweepScheduler;

  const makeScheduler = (intervalSeconds = INTERVAL_SECONDS): ReservationSweepScheduler =>
    new ReservationSweepScheduler(
      sweeper as unknown as SweepExpiredReservationsUseCase,
      registry,
      intervalSeconds,
      logger as unknown as PinoLogger,
    );

  beforeEach(() => {
    jest.useFakeTimers();
    registry = new SchedulerRegistry();
    sweeper = new FakeSweepUseCase();
    logger = makePinoLoggerMock();
    scheduler = makeScheduler();
  });

  afterEach(() => {
    // Guards the suite against the very leak this scheduler exists to avoid: a surviving
    // interval would keep firing into the next test's fake clock.
    if (registry.doesExist('interval', RESERVATION_SWEEP_INTERVAL_NAME)) {
      registry.deleteInterval(RESERVATION_SWEEP_INTERVAL_NAME);
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    it('registers an interval under the exported name, at the configured period', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      scheduler.onModuleInit();

      expect(registry.doesExist('interval', RESERVATION_SWEEP_INTERVAL_NAME)).toBe(true);
      expect(registry.getIntervals()).toEqual([RESERVATION_SWEEP_INTERVAL_NAME]);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), INTERVAL_MS);
    });

    it('derives the period from the injected seconds, not a constant', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      makeScheduler(45).onModuleInit();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 45_000);
    });

    it('logs the resolved cadence exactly once', () => {
      scheduler.onModuleInit();

      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        { intervalSeconds: INTERVAL_SECONDS },
        'Reservation sweep scheduled',
      );
    });

    it('does not invoke the use case eagerly — the first tick is one period away', () => {
      scheduler.onModuleInit();

      expect(sweeper.execute).not.toHaveBeenCalled();

      jest.advanceTimersByTime(INTERVAL_MS - 1);
      expect(sweeper.execute).not.toHaveBeenCalled();
    });
  });

  describe('the tick', () => {
    it('invokes the sweep once per elapsed period', async () => {
      scheduler.onModuleInit();

      await jest.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(sweeper.execute).toHaveBeenCalledTimes(1);
      expect(sweeper.execute).toHaveBeenCalledWith();

      await jest.advanceTimersByTimeAsync(INTERVAL_MS * 3);
      expect(sweeper.execute).toHaveBeenCalledTimes(4);
    });

    it('swallows a rejected sweep, warns with the error message, and ticks again', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);

      sweeper.execute
        .mockRejectedValueOnce(new Error('STOCK_WRITE_CONFLICT'))
        .mockResolvedValueOnce(EMPTY_SWEEP);

      scheduler.onModuleInit();

      await jest.advanceTimersByTimeAsync(INTERVAL_MS);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'STOCK_WRITE_CONFLICT' },
        'Reservation sweep failed',
      );

      // The scheduler survives the fault: the next tick still reaches the use case.
      await jest.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(sweeper.execute).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      expect(unhandled).not.toHaveBeenCalled();
      process.off('unhandledRejection', unhandled);
    });

    it('stringifies a non-Error rejection rather than logging `undefined`', async () => {
      sweeper.execute.mockRejectedValueOnce('broker down');

      scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(INTERVAL_MS);

      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'broker down' },
        'Reservation sweep failed',
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('deletes the interval and stops every further tick', async () => {
      scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(sweeper.execute).toHaveBeenCalledTimes(1);

      scheduler.onModuleDestroy();

      expect(registry.doesExist('interval', RESERVATION_SWEEP_INTERVAL_NAME)).toBe(false);
      expect(jest.getTimerCount()).toBe(0);

      await jest.advanceTimersByTimeAsync(INTERVAL_MS * 5);
      expect(sweeper.execute).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no interval was ever registered', () => {
      expect(() => scheduler.onModuleDestroy()).not.toThrow();
    });
  });
});
