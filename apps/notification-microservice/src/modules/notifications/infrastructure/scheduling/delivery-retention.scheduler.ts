import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { PurgeAgedDeliveriesUseCase } from '../../application/use-cases';

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
      this.logger.warn({ reason }, 'Notification delivery retention sweep failed');
    }
  }
}
