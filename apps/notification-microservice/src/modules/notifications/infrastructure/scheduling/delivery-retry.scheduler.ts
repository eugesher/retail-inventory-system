import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { RetryFailedDeliveriesUseCase } from '../../application/use-cases';

const SWEEP_INTERVAL_MS = 60_000;

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
      this.logger.warn({ reason }, 'Notification delivery retry sweep failed');
    }
  }
}
