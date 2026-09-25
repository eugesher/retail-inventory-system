import { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { PurgeExpiredIdempotencyKeysUseCase } from '../apps/retail-microservice/src/modules/orders/application/use-cases/purge-expired-idempotency-keys.use-case';
import { IdempotencyE2ESpecDataSource } from './data-source/idempotency.e2e-spec.data-source';

const PURGE_SCOPE = 'e2e-purge';
const HOUR_MS = 3_600_000;

describe('Idempotency key TTL purge sweep (e2e)', () => {
  const timeout = 60_000;

  let retailMicroservice: INestMicroservice;
  let dataSource: IdempotencyE2ESpecDataSource;
  let purge: PurgeExpiredIdempotencyKeysUseCase;

  const stamp = Date.now();
  const agedKey = `aged-${stamp}`;
  const controlKey = `control-${stamp}`;

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    retailMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      RetailMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          queue: MicroserviceQueueEnum.RETAIL_QUEUE,
          queueOptions: { durable: true },
        },
      },
    );
    await retailMicroservice.listen();

    dataSource = new IdempotencyE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
      timezone: 'Z',
    });
    await dataSource.initialize();

    purge = retailMicroservice.get(PurgeExpiredIdempotencyKeysUseCase, { strict: false });

    await dataSource.deleteIdempotencyKeysByScope(PURGE_SCOPE);
  }, timeout);

  afterAll(async () => {
    await dataSource?.deleteIdempotencyKeysByScope(PURGE_SCOPE);
    await retailMicroservice?.close();
    await dataSource?.destroy();
  });

  it('a purge at the current instant deletes neither a just-future nor a far-future row', async () => {
    await dataSource.insertIdempotencyKey({
      scope: PURGE_SCOPE,
      key: agedKey,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await dataSource.insertIdempotencyKey({
      scope: PURGE_SCOPE,
      key: controlKey,
      expiresAt: new Date(Date.now() + 48 * HOUR_MS),
    });

    expect(await dataSource.countIdempotencyKeysByScope(PURGE_SCOPE)).toBe(2);

    await purge.execute(new Date());

    expect(await dataSource.getIdempotencyKey(PURGE_SCOPE, agedKey)).toBeDefined();
    expect(await dataSource.getIdempotencyKey(PURGE_SCOPE, controlKey)).toBeDefined();
  });

  it('a purge at a future instant deletes exactly the aged row and keeps the control', async () => {
    const futureNow = new Date(Date.now() + HOUR_MS);

    const deleted = await purge.execute(futureNow);

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await dataSource.getIdempotencyKey(PURGE_SCOPE, agedKey)).toBeUndefined();
    expect(await dataSource.getIdempotencyKey(PURGE_SCOPE, controlKey)).toBeDefined();
    expect(await dataSource.countIdempotencyKeysByScope(PURGE_SCOPE)).toBe(1);
  });
});
