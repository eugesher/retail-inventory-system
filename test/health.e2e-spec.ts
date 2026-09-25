import { HttpStatus, INestApplication, INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as EventStoreMicroserviceAppModule } from '@retail-inventory-system/apps/event-store-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as NotificationMicroserviceAppModule } from '@retail-inventory-system/apps/notification-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum, SystemHealthView } from '@retail-inventory-system/contracts';

const SERVICES = ['catalog', 'inventory', 'retail', 'notification', 'event-store'];

describe('System health (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let eventStoreApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let notificationMicroservice: INestMicroservice;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const createMicroservice = (
    appModule: unknown,
    queue: MicroserviceQueueEnum,
  ): Promise<INestMicroservice> =>
    NestFactory.createMicroservice<MicroserviceOptions>(appModule as never, {
      logger: false,
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL!],
        queue,
        queueOptions: { durable: true },
      },
    });

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    retailMicroservice = await createMicroservice(
      RetailMicroserviceAppModule,
      MicroserviceQueueEnum.RETAIL_QUEUE,
    );
    catalogMicroservice = await createMicroservice(
      CatalogMicroserviceAppModule,
      MicroserviceQueueEnum.CATALOG_QUEUE,
    );
    inventoryMicroservice = await createMicroservice(
      InventoryMicroserviceAppModule,
      MicroserviceQueueEnum.INVENTORY_QUEUE,
    );
    notificationMicroservice = await createMicroservice(
      NotificationMicroserviceAppModule,
      MicroserviceQueueEnum.NOTIFICATION_EVENTS,
    );

    eventStoreApp = await NestFactory.create(EventStoreMicroserviceAppModule, { logger: false });
    eventStoreApp.connectMicroservice<MicroserviceOptions>(
      {
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          noAck: false,
          queue: MicroserviceQueueEnum.EVENT_STORE_FIREHOSE_QUEUE,
          queueOptions: { durable: true },
          exchange: 'ris.events',
          exchangeType: 'topic',
          wildcards: true,
        },
      },
      { inheritAppConfig: true },
    );
    eventStoreApp.connectMicroservice<MicroserviceOptions>(
      {
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          queue: MicroserviceQueueEnum.EVENT_STORE_QUERY_QUEUE,
          queueOptions: { durable: true },
        },
      },
      { inheritAppConfig: true },
    );
    await eventStoreApp.init();
    await eventStoreApp.startAllMicroservices();

    await Promise.all([
      retailMicroservice.listen(),
      catalogMicroservice.listen(),
      inventoryMicroservice.listen(),
      notificationMicroservice.listen(),
    ]);

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    await apiGatewayApp.init();
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await eventStoreApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await notificationMicroservice?.close().catch(() => undefined);
  }, timeout);

  it(
    'is @Public — a monitor carries no JWT',
    async () => {
      await server().get('/api/health').expect(HttpStatus.OK);
    },
    timeout,
  );

  it(
    'reports every deployable ok, with a latency, when all five are listening',
    async () => {
      const response = await server().get('/api/health').expect(HttpStatus.OK);
      const body = response.body as SystemHealthView;

      expect(body.status).toBe('ok');
      expect(Object.keys(body.services).sort()).toEqual([...SERVICES].sort());

      for (const name of SERVICES) {
        expect(body.services[name].status).toBe('ok');
        expect(body.services[name].latencyMs).toBeGreaterThanOrEqual(0);
      }
    },
    timeout,
  );

  it(
    'reports the dead service as timeout and the system as degraded — still HTTP 200',
    async () => {
      await notificationMicroservice.close();

      const startedAt = Date.now();
      const response = await server().get('/api/health').expect(HttpStatus.OK);
      const elapsedMs = Date.now() - startedAt;
      const body = response.body as SystemHealthView;

      expect(elapsedMs).toBeLessThan(1_000);

      expect(body.services.notification.status).toBe('timeout');
      expect(body.services.notification.latencyMs).toBeUndefined();

      expect(body.status).toBe('degraded');

      for (const name of SERVICES.filter((s) => s !== 'notification')) {
        expect(body.services[name].status).toBe('ok');
      }

      expect(response.status).toBe(HttpStatus.OK);
    },
    timeout,
  );
});
