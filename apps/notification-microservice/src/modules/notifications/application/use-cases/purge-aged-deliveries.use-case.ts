import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationDeliveryRepositoryPort,
  NOTIFICATION_DELIVERY_REPOSITORY,
  RETENTION_DELIVERY_DAYS,
} from '../ports';

const MS_PER_DAY = 86_400_000;

const PURGE_BATCH_SIZE = 500;

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

    if (deleted > 0) {
      this.logger.info(
        {
          deleted,
          horizon: horizon.toISOString(),
          retentionDays: this.retentionDays,
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
