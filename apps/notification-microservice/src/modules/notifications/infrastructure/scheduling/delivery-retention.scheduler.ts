import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { PurgeAgedDeliveriesUseCase } from '../../application/use-cases';

// The thin `@nestjs/schedule` driver for the delivery-retention sweep (ISSUE-08). A provider, not a
// controller — `ScheduleModule.forRoot()` (already wired in `notifications.module.ts` for the retry
// sweeper) discovers the `@Cron` and fires it. All purge logic lives in `PurgeAgedDeliveriesUseCase`;
// this class only schedules it and guards the tick, so a failed sweep never kills the loop (the
// `DeliveryRetryScheduler` precedent — the schedule decorator stays in `infrastructure/`).
//
// **`@Cron`, where its sibling in this same folder uses `@Interval`.** That is not an inconsistency:
// the retry sweep wants a steady 60s heartbeat (it is chasing live failures), while retention wants a
// *time of day* — the small hours, when a bounded `DELETE` on the busiest table in the schema costs
// nobody anything. `EVERY_DAY_AT_3AM` is the whole reason to reach for `@Cron` at all.
//
// *(It is also worth knowing that the `@Interval` next door is why a `@Cron` grep once "proved" the
// notification service had no scheduler. It has had one all along.)*
//
// **The tick does not bound a row's lifetime — `RETENTION_DELIVERY_DAYS` does.** All this cadence
// decides is how promptly an already-aged row is reclaimed. And because the use case takes a bounded
// batch, a large backlog drains over several nights rather than in one statement; that is the design,
// not a limitation.
@Injectable()
export class DeliveryRetentionScheduler {
  constructor(
    private readonly purge: PurgeAgedDeliveriesUseCase,
    @InjectPinoLogger(DeliveryRetentionScheduler.name)
    private readonly logger: PinoLogger,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'notification-delivery-retention-sweep' })
  public async sweep(): Promise<void> {
    try {
      await this.purge.execute();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A sweep fault must not stop the scheduler — log and let tomorrow's tick try again.
      this.logger.warn({ reason }, 'Notification delivery retention sweep failed');
    }
  }
}
