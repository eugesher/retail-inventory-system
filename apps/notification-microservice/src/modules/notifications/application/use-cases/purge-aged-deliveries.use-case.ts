import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationDeliveryRepositoryPort,
  NOTIFICATION_DELIVERY_REPOSITORY,
  RETENTION_DELIVERY_DAYS,
} from '../ports';

const MS_PER_DAY = 86_400_000;

// One sweep's ceiling. Bounded so a purge can never take a table-sized lock on the hot path of every
// order, fulfillment, return and refund. A backlog drains across ticks rather than in one statement —
// the sweep is housekeeping, and housekeeping does not get to stop the shop.
const PURGE_BATCH_SIZE = 500;

// Purge Aged Deliveries — the retention sweep `RETENTION_DELIVERY_DAYS` has named since the beginning
// and that **nothing implemented** (ISSUE-08).
//
// The key sat in the shared Joi schema every service validates at boot, `.default(90)`, with **no DI
// token, no provider, no reader**. An operator who set `RETENTION_DELIVERY_DAYS=7` got a clean boot,
// no warning, and no purge. Meanwhile `notification_delivery` was never deleted — not soft-deleted
// (`deletedAt` is inert *by design*: the row is the source of truth for *"did we already send this?"*)
// and not hard-deleted, because this did not exist. **The fastest-growing table in the schema was the
// one unbounded table with a config knob that claimed to bound it.**
//
// **The coupling this sweep accepts, stated once, here.** A delivery row is the dedupe anchor (the
// generated `delivery_dedupe_key`). Purging it retires that anchor: an event re-processed after the
// horizon would dispatch a **second** notification. That is safe *because RabbitMQ will not redeliver
// a ninety-day-old message* — a real argument, and one that stops holding if the horizon is ever
// shortened to something a broker can outlive. **The retention horizon and the dedupe guarantee are
// coupled, deliberately.**
//
// `now` is an explicit parameter defaulting to the wall clock: the scheduler passes the current
// instant, and a test passes a **future** one to force the purge deterministically without touching
// the system clock (the `PurgeExpiredIdempotencyKeysUseCase` seam, which its e2e runs on).
@Injectable()
export class PurgeAgedDeliveriesUseCase {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly deliveryRepository: INotificationDeliveryRepositoryPort,
    @Inject(RETENTION_DELIVERY_DAYS)
    private readonly retentionDays: number,
    @InjectPinoLogger(PurgeAgedDeliveriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(now: Date = new Date()): Promise<number> {
    const horizon = new Date(now.getTime() - this.retentionDays * MS_PER_DAY);
    const deleted = await this.deliveryRepository.deleteOlderThan(horizon, PURGE_BATCH_SIZE);

    // A sweep that removed rows is real churn and worth an `info` line; an empty sweep — the steady
    // state — stays at `debug` so a daily tick does not flood the log.
    if (deleted > 0) {
      this.logger.info(
        {
          deleted,
          horizon: horizon.toISOString(),
          retentionDays: this.retentionDays,
          // A full batch means there is more to take: the backlog drains on the next tick, and a
          // reader of the log should not mistake the ceiling for the total.
          batchFull: deleted === PURGE_BATCH_SIZE,
        },
        'Purged aged notification deliveries',
      );
    } else {
      this.logger.debug(
        { horizon: horizon.toISOString(), retentionDays: this.retentionDays },
        'Delivery retention sweep: nothing aged out',
      );
    }

    return deleted;
  }
}
