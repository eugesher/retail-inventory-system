import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReportStaleCaptureClaimsUseCase } from '../../../application/use-cases';
import { StaleCaptureClaimScheduler } from '../stale-capture-claim.scheduler';

// Nest stores the `@Cron` arguments as reflected metadata on the decorated METHOD (not the class), under
// these two string keys. They are not re-exported from the package root — only from
// `@nestjs/schedule/dist/schedule.constants` — so the keys are named here rather than deep-imported
// through a `dist/` path. If a future version renames them, the reads below return `undefined` and the
// schedule assertions go red: the failure is loud, which is the property that matters.
const SCHEDULE_CRON_OPTIONS = 'SCHEDULE_CRON_OPTIONS';
const SCHEDULER_NAME = 'SCHEDULER_NAME';

// The decorated handler itself. Read through the property descriptor rather than as
// `StaleCaptureClaimScheduler.prototype.sweep` for two reasons: a bare method reference trips
// `@typescript-eslint/unbound-method`, and this is where the metadata actually lives — `SetMetadata`
// defines it on `descriptor.value`, which IS this function object.
const sweepHandler = (): object =>
  Object.getOwnPropertyDescriptor(StaleCaptureClaimScheduler.prototype, 'sweep')?.value as object;

// A stand-in for the use case: the scheduler only ever calls `execute()` with no arguments.
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
    // Nothing else pins the cadence. A silent edit from `EVERY_10_MINUTES` to `EVERY_WEEK` would leave
    // every other test in the repository green while a stranded capture claim — a payment whose fate is
    // unknown — went unreported for days.
    it('is registered as a cron, every ten minutes, under a stable name', () => {
      const options: unknown = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, sweepHandler());

      expect(options).toEqual({ name: 'stale-capture-claim-report', cronTime: '0 */10 * * * *' });
      expect(Reflect.getMetadata(SCHEDULER_NAME, sweepHandler())).toBe(
        'stale-capture-claim-report',
      );
    });
  });

  describe('the tick', () => {
    // No `now` argument: the use case defaults to the wall clock. A scheduler that pinned an instant
    // would report against a horizon that never moves.
    it('delegates to the use case, with no arguments', async () => {
      await scheduler.sweep();

      expect(report.execute).toHaveBeenCalledTimes(1);
      expect(report.execute).toHaveBeenCalledWith();
    });

    // **What this `catch` buys is NOT the loop's survival**, and it is worth being exact, because the
    // comment on the class used to say otherwise. A `@Cron` handler is wrapped by Nest itself
    // (`ScheduleExplorer.wrapFunctionInTryCatchBlocks`), and the `cron` library catches on top of that —
    // a rethrow from here is swallowed twice over and the schedule ticks on regardless. *(Verified
    // against `cron@4.4.0`: a handler that throws on tick 1 still fires ticks 2, 3, 4.)*
    //
    // The one scheduler whose `catch` is genuinely load-bearing is `ReservationSweepScheduler`, which
    // bypasses the decorator — `setInterval(() => void this.sweep(), ms)` is unwrapped, and a rejection
    // there is an `unhandledRejection`, which Node ≥15 turns into a **dead process**. That is why its
    // spec, alone, asserts on `unhandledRejection`.
    //
    // What the local `catch` buys HERE is that the failure is **named**. Nest's wrapper logs a bare stack
    // under a generic `Scheduler` context — an operator learns that *a* sweep died, not *which*. This one
    // logs through the module's Pino logger, at `warn` (a lock timeout is churn, not an incident), with
    // the reason on a structured field. That is an observability guarantee, and it is the one pinned here.
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

      // A subsequent tick is unaffected — and, notably, it does not re-warn. A `warn` per failure, not
      // a `warn` that latches.
      await expect(scheduler.sweep()).resolves.toBeUndefined();
      expect(report.execute).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    // A rejection with a non-`Error` value is exactly what a broker or a driver throws on a bad day.
    // `err.message` on a string is `undefined`, and an operator reading `reason: undefined` learns nothing.
    it('stringifies a non-Error rejection rather than logging `undefined`', async () => {
      report.execute.mockRejectedValueOnce('connection reset');

      await scheduler.sweep();

      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'connection reset' },
        'Stale capture claim report failed',
      );
    });

    // The use case REPORTS and resolves nothing (ADR-052) — it cannot, because `IPaymentGatewayPort` has
    // no "did my capture land?" query. The scheduler must not quietly grow a fix-it branch by analogy
    // with `ReservationSweepScheduler`, which releases stock holds where a wrong guess is cheap. Here a
    // wrong guess charges a customer twice. So a tick that finds stranded rows does exactly what a tick
    // that finds none does: nothing.
    it('does not act on the reported rows — a found claim is still only a log line', async () => {
      report.execute.mockResolvedValueOnce(3);

      await scheduler.sweep();

      expect(logger.warn).not.toHaveBeenCalled();
      // The scheduler has no other collaborator to reach for, and that is the design, not an omission:
      // its only injected dependency besides the logger IS the report.
      expect(report.execute).toHaveBeenCalledTimes(1);
    });
  });
});
