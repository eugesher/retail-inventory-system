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
// `RetryFailedDeliveriesUseCase`; this class only schedules it and guards the tick so a
// thrown sweep never crashes the scheduler loop.
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
      // A sweep fault must not stop the scheduler — log and let the next tick try again.
      this.logger.warn({ reason }, 'Notification delivery retry sweep failed');
    }
  }
}
