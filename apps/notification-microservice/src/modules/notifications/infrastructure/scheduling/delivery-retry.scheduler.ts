import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { RetryFailedDeliveriesUseCase } from '../../application/use-cases';

// How often the retry sweep runs (milliseconds). 60s is the production-sane cadence — the
// backoff gate inside the sweeper, not this interval, is what spaces an individual
// delivery's re-attempts, so a frequent tick just keeps the longest-waiting `failed` rows
// moving without hammering the transport. (The manual `notification.delivery.retry` RPC is
// the immediate, operator-forced path; an e2e exercises the retry through it rather than
// waiting on this interval.)
const SWEEP_INTERVAL_MS = 60_000;

// The thin `@nestjs/schedule` driver for the retry sweeper (ADR-033). It is a provider
// (not a controller) — `ScheduleModule.forRoot()` (wired in `notifications.module.ts`)
// discovers the `@Interval` method and invokes it on the timer. All retry logic lives in
// `RetryFailedDeliveriesUseCase`; this class only schedules it.
@Injectable()
export class DeliveryRetryScheduler {
  constructor(
    private readonly sweeper: RetryFailedDeliveriesUseCase,
    @InjectPinoLogger(DeliveryRetryScheduler.name)
    private readonly logger: PinoLogger,
  ) {}

  @Interval('notification-delivery-retry-sweep', SWEEP_INTERVAL_MS)
  public async sweep(): Promise<void> {
    try {
      await this.sweeper.execute();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // **This catch does not keep the loop alive — the loop was never at risk.** A decorator-registered
      // handler (`@Interval` here, `@Cron` elsewhere) is wrapped by Nest itself
      // (`ScheduleExplorer.wrapFunctionInTryCatchBlocks`); a rethrow would be caught there and the timer
      // would fire again. (Inventory's `ReservationSweepScheduler` is the one whose catch IS
      // load-bearing: it hands a raw `setInterval` to the registry, unwrapped, so a rejection there is an
      // `unhandledRejection` — a dead process on Node ≥15.)
      //
      // What it buys is that the failure is **named**: Nest's wrapper logs a bare stack under a generic
      // `Scheduler` context, so an operator learns that *a* sweep died, not *which*.
      this.logger.warn({ reason }, 'Notification delivery retry sweep failed');
    }
  }
}
