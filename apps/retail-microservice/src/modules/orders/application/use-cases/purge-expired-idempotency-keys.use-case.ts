import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IDEMPOTENCY_STORE, IIdempotencyStorePort } from '../ports';

// Purge Expired Idempotency Keys — the application half of the TTL sweep (ADR-036). It owns
// nothing but the delete-and-count; the rule it enforces (the sweep is the sole authority that
// removes an expired row, because `find` never filters by expiry) is stated once, on
// `IIdempotencyStorePort.deleteExpired`.
//
// `now` is an explicit parameter, defaulting to the wall clock, so the scheduler passes the
// current instant while a test can pass a **future** one and force deletion deterministically
// without touching the system clock. That is the seam `test/idempotency-purge.e2e-spec.ts` runs
// on: seed a row, purge at a future `now`, observe the deletion.
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
