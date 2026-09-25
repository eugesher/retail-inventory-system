import { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { AppModule as NotificationMicroserviceAppModule } from '@retail-inventory-system/apps/notification-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { PurgeAgedDeliveriesUseCase } from '../apps/notification-microservice/src/modules/notifications/application/use-cases';
import { DeliveryRetentionE2ESpecDataSource } from './data-source/delivery-retention.e2e-spec.data-source';

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 90;

describe('Notification delivery retention purge (e2e)', () => {
  const timeout = 60_000;

  let notificationMicroservice: INestMicroservice;
  let dataSource: DeliveryRetentionE2ESpecDataSource;
  let purge: PurgeAgedDeliveriesUseCase;

  const stamp = Date.now();
  const realNow = new Date();

  let templateId: number;
  let agedId: number;
  let freshId: number;

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

    purge = notificationMicroservice.get(PurgeAgedDeliveriesUseCase, { strict: false });

    dataSource = new DeliveryRetentionE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    templateId = await dataSource.anyTemplateId();

    agedId = await dataSource.seedDelivery(
      templateId,
      `retention-aged-${stamp}`,
      new Date(realNow.getTime() - 100 * DAY_MS),
    );
    freshId = await dataSource.seedDelivery(templateId, `retention-fresh-${stamp}`, realNow);
  }, timeout);

  afterAll(async () => {
    await notificationMicroservice?.close();
    await dataSource?.destroy();
  });

  it(
    'deletes a row past the horizon and leaves one inside it — a real DELETE, in MySQL',
    async () => {
      expect(await dataSource.deliveryExists(agedId)).toBe(true);
      expect(await dataSource.deliveryExists(freshId)).toBe(true);

      const deleted = await purge.execute(realNow);

      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(await dataSource.deliveryExists(agedId)).toBe(false);
      expect(await dataSource.deliveryExists(freshId)).toBe(true);
    },
    timeout,
  );

  it(
    'honours the CONFIGURED horizon — the fresh row ages out once `now` moves past it',
    async () => {
      const wayLater = new Date(realNow.getTime() + (RETENTION_DAYS + 1) * DAY_MS);

      const deleted = await purge.execute(wayLater);

      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(await dataSource.deliveryExists(freshId)).toBe(false);
    },
    timeout,
  );

  it(
    'an empty sweep deletes nothing and does not throw',
    async () => {
      await expect(purge.execute(realNow)).resolves.toBe(0);
    },
    timeout,
  );
});
