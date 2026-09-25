import { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { AppModule as NotificationMicroserviceAppModule } from '@retail-inventory-system/apps/notification-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import {
  QUEUED_STALE_AFTER_MS,
  RetryDeliveryUseCase,
  RetryFailedDeliveriesUseCase,
} from '../apps/notification-microservice/src/modules/notifications/application/use-cases';
import { OrphanedQueuedE2ESpecDataSource } from './data-source/orphaned-queued.e2e-spec.data-source';

const MINUTE_MS = 60_000;

describe('Notification delivery orphaned in queued (e2e)', () => {
  const timeout = 60_000;

  let notificationMicroservice: INestMicroservice;
  let dataSource: OrphanedQueuedE2ESpecDataSource;
  let sweeper: RetryFailedDeliveriesUseCase;
  let manualRetry: RetryDeliveryUseCase;

  const stamp = Date.now();
  const realNow = new Date();

  let templateId: number;
  let orphanId: number;
  let freshId: number;
  let manualOrphanId: number | undefined;

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    notificationMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      NotificationMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          queue: MicroserviceQueueEnum.NOTIFICATION_EVENTS,
          queueOptions: { durable: true },
        },
      },
    );
    await notificationMicroservice.listen();

    sweeper = notificationMicroservice.get(RetryFailedDeliveriesUseCase, { strict: false });
    manualRetry = notificationMicroservice.get(RetryDeliveryUseCase, { strict: false });

    dataSource = new OrphanedQueuedE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
      timezone: 'Z',
    });
    await dataSource.initialize();

    templateId = await dataSource.anyTemplateId();

    orphanId = await dataSource.seedOrphanedQueued(
      templateId,
      `orphan-swept-${stamp}`,
      new Date(realNow.getTime() - (QUEUED_STALE_AFTER_MS + 10 * MINUTE_MS)),
    );
    freshId = await dataSource.seedOrphanedQueued(templateId, `orphan-fresh-${stamp}`, realNow);
  }, timeout);

  afterAll(async () => {
    await dataSource?.deleteDelivery(orphanId);
    await dataSource?.deleteDelivery(freshId);
    if (manualOrphanId !== undefined) {
      await dataSource.deleteDelivery(manualOrphanId);
    }
    await notificationMicroservice?.close();
    await dataSource?.destroy();
  });

  it(
    'the scheduled sweep rescues the orphan and leaves the fresh queued row alone',
    async () => {
      expect((await dataSource.statusOf(orphanId))?.status).toBe('queued');
      expect((await dataSource.statusOf(freshId))?.status).toBe('queued');

      await sweeper.execute();

      const rescued = await dataSource.statusOf(orphanId);
      expect(rescued?.status).toBe('sent');
      expect(rescued?.attemptCount).toBe(1);

      const untouched = await dataSource.statusOf(freshId);
      expect(untouched?.status).toBe('queued');
      expect(untouched?.attemptCount).toBe(0);
    },
    timeout,
  );

  it(
    'the operator manual retry also accepts an orphan, and still refuses a fresh queued row',
    async () => {
      manualOrphanId = await dataSource.seedOrphanedQueued(
        templateId,
        `orphan-manual-${stamp}`,
        new Date(Date.now() - (QUEUED_STALE_AFTER_MS + 10 * MINUTE_MS)),
      );

      const view = await manualRetry.execute({
        deliveryId: manualOrphanId,
        correlationId: `corr-manual-orphan-${stamp}`,
      });
      expect(view.status).toBe('sent');
      expect(view.attemptCount).toBe(1);

      await expect(
        manualRetry.execute({ deliveryId: freshId, correlationId: `corr-manual-fresh-${stamp}` }),
      ).rejects.toMatchObject({ code: 'NOTIFICATION_DELIVERY_INVALID_STATUS_TRANSITION' });
      expect((await dataSource.statusOf(freshId))?.status).toBe('queued');
    },
    timeout,
  );

  it(
    'a rescued row is an ordinary delivery afterwards — a second sweep does not touch it',
    async () => {
      await sweeper.execute();

      const after = await dataSource.statusOf(orphanId);
      expect(after?.status).toBe('sent');
      expect(after?.attemptCount).toBe(1);
    },
    timeout,
  );
});
