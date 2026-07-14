import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ReportStaleCaptureClaimsUseCase } from '../../application/use-cases';

// The thin `@nestjs/schedule` driver for the stranded-capture-claim report (ADR-052). A provider, not
// a controller — `ScheduleModule.forRoot()` (already wired in `orders.module.ts` for the idempotency
// purge) discovers the `@Cron` and fires it. All logic lives in `ReportStaleCaptureClaimsUseCase`;
// this class only schedules it (the `IdempotencyPurgeScheduler` precedent — the schedule decorator
// stays in `infrastructure/`).
//
// **It reports; it does not sweep.** A stranded `CAPTURING` row is a capture that died mid-flight, and
// nothing here knows whether the money moved — the gateway has no "did it?" query. Releasing the claim
// would invite a second charge; completing it would record a charge that may never have happened. So
// the tick surfaces the row at `error` and stops. See the use case for why that is the design and not
// an unfinished one.
//
// **Ten minutes, deliberately coarse.** The interval does not bound anything: a real capture resolves
// in a gateway round-trip, so a claim that survives one tick has already failed. The tick only decides
// how quickly an operator hears about it, and hearing about it a few minutes later changes nothing —
// the reconciliation is manual either way. Tightening it buys noise.
@Injectable()
export class StaleCaptureClaimScheduler {
  constructor(
    private readonly report: ReportStaleCaptureClaimsUseCase,
    @InjectPinoLogger(StaleCaptureClaimScheduler.name)
    private readonly logger: PinoLogger,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'stale-capture-claim-report' })
  public async sweep(): Promise<void> {
    try {
      await this.report.execute();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // **This catch does not keep the loop alive — the loop was never at risk.** A `@Cron` handler is
      // already wrapped by Nest (`ScheduleExplorer.wrapFunctionInTryCatchBlocks`), and the `cron`
      // library catches on top of that; a rethrow would be swallowed twice and the schedule would tick
      // on. (Inventory's `ReservationSweepScheduler` is the one whose catch IS load-bearing: it hands a
      // raw `setInterval` to the registry, so a rejection there is an `unhandledRejection` — a dead
      // process on Node ≥15.)
      //
      // What it buys is that the failure is **named**: Nest's wrapper logs a bare stack under a generic
      // `Scheduler` context, so an operator learns that *a* sweep died, not *which*. `warn`, not `error`
      // — a lock timeout on a report is churn; the `error` lines that matter come from the use case.
      this.logger.warn({ reason }, 'Stale capture claim report failed');
    }
  }
}
