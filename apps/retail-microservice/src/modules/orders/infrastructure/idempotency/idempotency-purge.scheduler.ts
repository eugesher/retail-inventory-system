import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { PurgeExpiredIdempotencyKeysUseCase } from '../../application/use-cases';

// The thin `@nestjs/schedule` driver for the idempotency-key TTL purge (ADR-036). It is a
// provider (not a controller) — `ScheduleModule.forRoot()` (wired in `orders.module.ts`)
// discovers the `@Cron` method and fires it on the timer. All purge logic lives in
// `PurgeExpiredIdempotencyKeysUseCase`; this class only schedules it and guards the tick so
// a thrown sweep never crashes the scheduler loop (the notification `DeliveryRetryScheduler`
// precedent — the schedule decorator stays in `infrastructure/`, never in the use case).
//
// **The tick does not bound a row's lifetime — `IDEMPOTENCY_KEY_TTL_HOURS` does.** All this
// interval decides is how promptly an already-expired row is reclaimed, which is why it can
// afford to be coarse. Tightening it buys a smaller table and nothing else; a replay window is
// set by the TTL, never by the sweep.
@Injectable()
export class IdempotencyPurgeScheduler {
  constructor(
    private readonly purge: PurgeExpiredIdempotencyKeysUseCase,
    @InjectPinoLogger(IdempotencyPurgeScheduler.name)
    private readonly logger: PinoLogger,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'idempotency-key-purge-sweep' })
  public async sweep(): Promise<void> {
    try {
      await this.purge.execute();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A sweep fault must not stop the scheduler — log and let the next tick try again.
      this.logger.warn({ reason }, 'Idempotency key purge sweep failed');
    }
  }
}
