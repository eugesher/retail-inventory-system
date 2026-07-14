import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { PurgeAgedDeliveriesUseCase } from '../../../application/use-cases';
import { DeliveryRetentionScheduler } from '../delivery-retention.scheduler';

// Nest stores the `@Cron` arguments as reflected metadata on the decorated METHOD (not the class), under
// these two string keys. They are not re-exported from the package root — only from
// `@nestjs/schedule/dist/schedule.constants` — so the keys are named here rather than deep-imported
// through a `dist/` path. If a future version renames them, the reads below return `undefined` and the
// schedule assertions go red: the failure is loud, which is the property that matters.
const SCHEDULE_CRON_OPTIONS = 'SCHEDULE_CRON_OPTIONS';
const SCHEDULER_NAME = 'SCHEDULER_NAME';

// The decorated handler itself. Read through the property descriptor rather than as
// `DeliveryRetentionScheduler.prototype.sweep` for two reasons: a bare method reference trips
// `@typescript-eslint/unbound-method`, and this is where the metadata actually lives — `SetMetadata`
// defines it on `descriptor.value`, which IS this function object.
const sweepHandler = (): object =>
  Object.getOwnPropertyDescriptor(DeliveryRetentionScheduler.prototype, 'sweep')?.value as object;

// A stand-in for the use case: the scheduler only ever calls `execute()` with no arguments.
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
    // Nothing else pins the cadence, and the cadence is the whole reason this class reaches for `@Cron`
    // where its sibling in the same folder uses `@Interval`: retention wants a TIME OF DAY. An edit to
    // `EVERY_MINUTE` would leave every other test green while a bounded `DELETE` ran against the busiest
    // table in the schema sixty times an hour, in business hours.
    it('is registered as a cron, at 03:00, under a stable name', () => {
      const options: unknown = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, sweepHandler());

      // Five fields, not six: `EVERY_DAY_AT_3AM` is minute-precision. (`EVERY_10_MINUTES` next door in
      // retail is six — the two forms coexist in `CronExpression`, so the literal is worth pinning.)
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
    // No `now` argument: the use case defaults to the wall clock and derives the horizon from
    // `RETENTION_DELIVERY_DAYS`. A scheduler that pinned an instant would purge against a horizon frozen
    // at boot — and the process is long-lived.
    it('delegates to the use case, with no arguments', async () => {
      await scheduler.sweep();

      expect(purge.execute).toHaveBeenCalledTimes(1);
      expect(purge.execute).toHaveBeenCalledWith();
    });

    // **What this `catch` buys is NOT the loop's survival**, and it is worth being exact, because the
    // comment on the class used to say otherwise. A `@Cron` handler is wrapped by Nest itself
    // (`ScheduleExplorer.wrapFunctionInTryCatchBlocks`), and the `cron` library catches on top of that —
    // a rethrow from here is swallowed twice over and the schedule ticks on regardless. *(Verified
    // against `cron@4.4.0`: a handler that throws on tick 1 still fires ticks 2, 3, 4.)*
    //
    // The one scheduler whose `catch` is genuinely load-bearing is inventory's `ReservationSweepScheduler`,
    // which bypasses the decorator — `setInterval(() => void this.sweep(), ms)` is unwrapped, and a
    // rejection there is an `unhandledRejection`, which Node ≥15 turns into a **dead process**. That is
    // why its spec, alone, asserts on `unhandledRejection`.
    //
    // What the local `catch` buys HERE is that the failure is **named**. Nest's wrapper logs a bare stack
    // under a generic `Scheduler` context — an operator learns that *a* sweep died, not *which*. For a
    // sweep that runs once a night, on the one table that grows without bound, being able to grep for it
    // by name is the difference between noticing a stalled retention and not.
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

      // Tomorrow's tick is unaffected — and, notably, it does not re-warn. A `warn` per failure, not a
      // `warn` that latches.
      await expect(scheduler.sweep()).resolves.toBeUndefined();
      expect(purge.execute).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    // A rejection with a non-`Error` value is exactly what a driver throws on a bad day. `err.message` on
    // a string is `undefined`, and an operator reading `reason: undefined` learns nothing.
    it('stringifies a non-Error rejection rather than logging `undefined`', async () => {
      purge.execute.mockRejectedValueOnce('connection reset');

      await scheduler.sweep();

      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'connection reset' },
        'Notification delivery retention sweep failed',
      );
    });

    // A successful sweep is silent HERE: the use case owns the log line (`info` when rows went, `debug`
    // when none did). The scheduler adding its own would double every entry.
    it('says nothing of its own on a successful sweep', async () => {
      purge.execute.mockResolvedValueOnce(500);

      await scheduler.sweep();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
