import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IDEMPOTENCY_STORE, IIdempotencyStorePort } from '../ports';

// Purge Expired Idempotency Keys — the application half of the TTL sweep (ADR-036). The
// `idempotency_key` store is live-ephemeral: `find` never filters by expiry, so a
// scheduled sweep is the SOLE authority that removes a row once its `expires_at` horizon
// has passed, keeping the table bounded by the retention window rather than by all-time
// traffic. This use case owns nothing but the delete-and-count; the `@nestjs/schedule`
// cadence lives in `IdempotencyPurgeScheduler` (infrastructure), the notification
// `DeliveryRetryScheduler` precedent — so the schedule decorator never touches the
// application layer (ADR-004 / ADR-017).
//
// `now` is an explicit parameter (defaulting to the wall clock) so the scheduler passes
// the current instant while a test can pass a future one to force deterministic deletion
// without touching the system clock — the testing seam the concurrency e2e leans on
// ("leave a row, advance simulated time, observe deletion").
@Injectable()
export class PurgeExpiredIdempotencyKeysUseCase {
  constructor(
    @Inject(IDEMPOTENCY_STORE)
    private readonly idempotencyStore: IIdempotencyStorePort,
    @InjectPinoLogger(PurgeExpiredIdempotencyKeysUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(now: Date = new Date()): Promise<number> {
    const deleted = await this.idempotencyStore.deleteExpired(now);

    // A sweep that removed rows is worth an `info` line (it reflects real churn); an empty
    // sweep — the steady state on a low-traffic table — stays at `debug` so the log is not
    // flooded every ten minutes.
    if (deleted > 0) {
      this.logger.info({ deleted, now: now.toISOString() }, 'Purged expired idempotency keys');
    } else {
      this.logger.debug({ now: now.toISOString() }, 'Idempotency purge sweep: nothing expired');
    }

    return deleted;
  }
}
