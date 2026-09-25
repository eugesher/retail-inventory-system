import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { randomUUID } from 'node:crypto';

import {
  INotificationDeliveryRepositoryPort,
  MAX_DELIVERY_ATTEMPTS,
  NOTIFICATION_DELIVERY_REPOSITORY,
} from '../ports';
import { staleQueuedHorizon } from './queued-staleness';
import { RetryDeliveryUseCase } from './retry-delivery.use-case';

const RETRY_BACKOFF_BASE_MS = 1_000;

const SWEEP_BATCH_SIZE = 50;

export interface IRetrySweepResult {
  scanned: number;
  skipped: number;
  retried: number;
}

@Injectable()
export class RetryFailedDeliveriesUseCase {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly deliveryRepo: INotificationDeliveryRepositoryPort,
    private readonly retryDelivery: RetryDeliveryUseCase,
    @Inject(MAX_DELIVERY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(RetryFailedDeliveriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(): Promise<IRetrySweepResult> {
    const sweepCorrelationId = randomUUID();
    const now = new Date();

    const items = await this.deliveryRepo.listRetryable(
      this.maxAttempts,
      SWEEP_BATCH_SIZE,
      staleQueuedHorizon(now),
    );

    let skipped = 0;
    let retried = 0;

    for (const delivery of items) {
      if (!this.isDue(delivery.lastAttemptAt, delivery.attemptCount, now)) {
        skipped += 1;
        continue;
      }
      try {
        await this.retryDelivery.reattempt(delivery, delivery.correlationId);
        retried += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          { correlationId: sweepCorrelationId, deliveryId: delivery.id, reason },
          'Retry sweep: a delivery retry threw; continuing',
        );
      }
    }

    this.logger.info(
      { correlationId: sweepCorrelationId, scanned: items.length, skipped, retried },
      'Notification delivery retry sweep complete',
    );

    return { scanned: items.length, skipped, retried };
  }

  private isDue(lastAttemptAt: Date | null, attemptCount: number, now: Date): boolean {
    if (lastAttemptAt === null) {
      return true;
    }
    const backoffMs = RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1);
    return lastAttemptAt.getTime() + backoffMs <= now.getTime();
  }
}
