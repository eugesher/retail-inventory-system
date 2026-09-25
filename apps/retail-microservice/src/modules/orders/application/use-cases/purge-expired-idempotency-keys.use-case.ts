import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IDEMPOTENCY_STORE, IIdempotencyStorePort } from '../ports';

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

    if (deleted > 0) {
      this.logger.info({ deleted, now: now.toISOString() }, 'Purged expired idempotency keys');
    } else {
      this.logger.debug({ now: now.toISOString() }, 'Idempotency purge sweep: nothing expired');
    }

    return deleted;
  }
}
