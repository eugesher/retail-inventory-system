import { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { AppModule as NotificationMicroserviceAppModule } from '@retail-inventory-system/apps/notification-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { PurgeAgedDeliveriesUseCase } from '../apps/notification-microservice/src/modules/notifications/application/use-cases';
import { DeliveryRetentionE2ESpecDataSource } from './data-source/delivery-retention.e2e-spec.data-source';

// The delivery-retention sweep (ISSUE-08) — **the reader `RETENTION_DELIVERY_DAYS` never had.**
//
// The key sat in the shared Joi schema that every service validates at boot, `.default(90)`, and
// **nothing read it**: no DI token, no provider, no use case, no scheduler. An operator who set
// `RETENTION_DELIVERY_DAYS=7` got a clean boot, no warning, and no purge — and the only way to find
// out was to grep the source, which is exactly what an operator will not do, because the key
// validates and has a sensible default. Meanwhile `notification_delivery` was never deleted at all:
// not soft-deleted (`deletedAt` is inert **by design** — the row is the source of truth for *"did we
// already send this?"*) and not hard-deleted, because there was no sweep. **The fastest-growing table
// in the schema was the one unbounded table with a config knob that claimed to bound it.**
//
// This suite resolves the real `PurgeAgedDeliveriesUseCase` out of the running notification service
// and drives it through its explicit-`now` seam — `execute(now)` takes the instant the horizon is
// measured back from, so the suite can "seed an old row, advance simulated time, observe the
// deletion" **without touching the system clock or waiting out ninety real days** (the
// `PurgeExpiredIdempotencyKeysUseCase` precedent, which its own e2e runs on).
//
// It asserts against the TABLE, and it must: a purge's entire observable effect is the row's absence,
// and no application read path can tell "purged" from "never existed".
const DAY_MS = 86_400_000;
// The Joi default the service boots with. The horizon under test is therefore 90 days back from
// whatever `now` the spec passes.
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

    // AGED: 100 days old — past a 90-day horizon measured from the real now.
    agedId = await dataSource.seedDelivery(
      templateId,
      `retention-aged-${stamp}`,
      new Date(realNow.getTime() - 100 * DAY_MS),
    );
    // FRESH: created just now. It must survive every sweep in this file.
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
      // **The row is gone.** Not soft-deleted — gone. Soft-deleting is the tempting shortcut and it is
      // wrong: the row IS the dedupe anchor (`delivery_dedupe_key`), so a hidden-but-present row the
      // dedupe query no longer sees means the same notification sends twice. Hard delete, or nothing.
      expect(await dataSource.deliveryExists(agedId)).toBe(false);
      expect(await dataSource.deliveryExists(freshId)).toBe(true);
    },
    timeout,
  );

  it(
    'honours the CONFIGURED horizon — the fresh row ages out once `now` moves past it',
    async () => {
      // Same row, same code, same 90-day horizon — only the instant it is measured from moves. This is
      // the `now` seam earning its keep: a sweep that read the wall clock could not be tested at all
      // without sleeping or lying about the system time.
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
      // Everything this spec seeded is already gone; a sweep at the real `now` must be a clean no-op.
      // The steady state of a retention sweep is doing nothing, and it has to be boring.
      await expect(purge.execute(realNow)).resolves.toBe(0);
    },
    timeout,
  );
});
