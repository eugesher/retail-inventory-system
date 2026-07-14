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

// Proves `GET /api/health` end-to-end (ADR-044): the gateway fans a liveness probe out to all
// five RMQ deployables over the real broker and rolls the answers into one verdict.
//
// The suite runs in TWO phases against the SAME gateway, and the second is the one that
// matters. A health endpoint that only ever reports `ok` is untested: the whole reason it
// exists is to tell you when something is *not* ok, and that path — timeout, roll-up to
// `degraded`, still 200 — is the one a bug would hide in.
//
//   Phase 1: all five services listening → `status: 'ok'`, every service `ok`.
//   Phase 2: notification closed, its queue left with no consumer → that one service reports
//            `timeout`, the verdict flips to `degraded`, the other four keep answering `ok`,
//            and the HTTP status is STILL 200.
//
// Phase 2 also pins the cost: the fan-out is concurrent, so one dead service costs one
// timeout, not five. `HEALTH_PROBE_TIMEOUT_MS` is lowered for this suite so the assertion
// does not idle for the 2 s production default.
const SERVICES = ['catalog', 'inventory', 'retail', 'notification', 'event-store'];

// `HEALTH_PROBE_TIMEOUT_MS` is pinned to 400 ms in `test/jest.setup.ts` — it cannot be set in
// `beforeAll`, because `ConfigModule.forRoot` runs inside a `@Module` decorator argument and
// therefore at AppModule *import* time, above the hoisted spec imports. The degraded test
// asserts the request comes back well under the 2 s production default, which is what proves
// the value provider actually reaches the adapter. (This nearly slipped past: closing an
// `INestMicroservice` takes ~2 s of its own, so timing the whole test rather than the request
// makes a broken knob look correct.)

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

    // The event store's hybrid boot, exactly as its `main.ts` does it — `init()` before
    // `startAllMicroservices()`, `listen()` never. Its health ping rides the QUERY queue
    // (`audit.health.ping` is a command, ADR-039), which is why both transports must be up.
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
    // The degraded-path test already closed this one; a second close must not fail teardown.
    await notificationMicroservice?.close().catch(() => undefined);
  }, timeout);

  it(
    'is @Public — a monitor carries no JWT',
    async () => {
      // No Authorization header. A health endpoint behind auth cannot answer the one
      // question it exists for.
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
        // Probed over the real broker, so a latency proves a round trip actually happened —
        // a stubbed `ok` would have none.
        expect(body.services[name].status).toBe('ok');
        expect(body.services[name].latencyMs).toBeGreaterThanOrEqual(0);
      }
    },
    timeout,
  );

  it(
    'reports the dead service as timeout and the system as degraded — still HTTP 200',
    async () => {
      // Close notification: its queue survives (it is durable), but nothing consumes it, so
      // the probe gets no reply and must time out rather than error.
      await notificationMicroservice.close();

      const startedAt = Date.now();
      const response = await server().get('/api/health').expect(HttpStatus.OK);
      const elapsedMs = Date.now() - startedAt;
      const body = response.body as SystemHealthView;

      // The probe timed out at OUR configured bound, not at the 2 s default — proof the
      // `HEALTH_PROBE_TIMEOUT_MS` value provider actually reaches the adapter.
      expect(elapsedMs).toBeLessThan(1_000);

      expect(body.services.notification.status).toBe('timeout');
      expect(body.services.notification.latencyMs).toBeUndefined();

      // The verdict is harsh on purpose: four of five is not healthy.
      expect(body.status).toBe('degraded');

      // ...and the other four still answered. This is what `Promise.all` over a
      // never-rejecting `probeOne` buys: one dead service does not blind the report.
      for (const name of SERVICES.filter((s) => s !== 'notification')) {
        expect(body.services[name].status).toBe('ok');
      }

      // 200, not 503: the gateway is provably alive — it is the thing that answered.
      expect(response.status).toBe(HttpStatus.OK);
    },
    timeout,
  );
});
