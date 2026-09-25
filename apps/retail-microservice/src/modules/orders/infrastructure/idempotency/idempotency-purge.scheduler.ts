import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { PurgeExpiredIdempotencyKeysUseCase } from '../../application/use-cases';

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
      this.logger.warn({ reason }, 'Idempotency key purge sweep failed');
    }
  }
}
