import { randomUUID } from 'crypto';

import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as EventStoreMicroserviceAppModule } from '@retail-inventory-system/apps/event-store-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { EventStoreE2ESpecDataSource } from './data-source/event-store.e2e-spec.data-source';
import { IdempotencyE2ESpecDataSource } from './data-source/idempotency.e2e-spec.data-source';

// The headline Place Order idempotency guarantee (ADR-036). One customer fires the SAME
// `POST /cart/:id/place` twice under one `Idempotency-Key`. The store's find-first replay
// (ADR-036) makes the second call a pure replay: BOTH responses carry the same `orderId`,
// exactly ONE order exists in `retail_db`, and — the "one logical place = one event"
// oracle — exactly ONE `retail.order.placed` row lands in the isolated
// `ris_eventstore.domain_event` firehose log (ADR-035). The replay short-circuits BEFORE
// the event publisher, so it emits nothing; the second HTTP response carries
// `Idempotent-Replay: true` and downgrades to `200` (a fresh place is `201`).
//
// The event-store oracle is asserted by direct SQL (there is no query endpoint — a deferred
// capability), keyed on `(event_type, aggregate_id)` so it is independent of the correlation
// id. Ingestion is asynchronous (publish → broker → consume → insert), so the suite polls
// the log until the placed event appears before asserting the count.
//
// Self-provisioned, disjoint fixture (`e2e-idem-place-*`): its own product/price/published/
// received stock, so the shared seeded variants are never touched.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const KEY_ORDER_PLACED = 'retail.order.placed';

const ADDRESS = {
  recipientName: 'Jane Buyer',
  line1: '1 Market St',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94105',
  country: 'US',
};

interface ITokenResponse {
  accessToken: string;
}

interface ICartBody {
  id: string;
}

interface IOrderBody {
  id: number;
  status: string;
}

describe('Idempotent Place Order: replay returns one order + one event (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let eventStoreMicroservice: INestMicroservice;
  let eventStore: EventStoreE2ESpecDataSource;
  let retailDb: IdempotencyE2ESpecDataSource;

  const stamp = Date.now();
  const idempotencyKey = `idem-place-${stamp}-${randomUUID()}`;
  let adminAuth: string;
  let customerToken: string;
  let variantId: number;
  let cartId: string;
  let firstOrder: IOrderBody;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const waitForStockRow = async (id: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await retailDb.getStockLevelRows(id)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${id}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  // Poll `domain_event` until the placed event for THIS order has been ingested off the bus.
  const waitForPlacedEvent = async (orderId: number, deadlineMs = 30_000): Promise<void> => {
    const start = Date.now();
    for (;;) {
      const count = await eventStore.countDomainEventsByTypeAndAggregateId(
        KEY_ORDER_PLACED,
        String(orderId),
      );
      if (count >= 1) {
        return;
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for ${KEY_ORDER_PLACED} of order ${orderId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

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

  const place = (key: string): supertest.Test =>
    server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', key)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });

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

    // The event store binds the firehose queue to the `ris.events` TOPIC exchange with the
    // `#` catch-all — the same shape as its `main.ts`, so the in-process `FirehoseConsumer`
    // receives the entire firehose and ingests it into `domain_event`.
    eventStoreMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      EventStoreMicroserviceAppModule,
      {
        logger: false,
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
    );

    await Promise.all([
      retailMicroservice.listen(),
      catalogMicroservice.listen(),
      inventoryMicroservice.listen(),
      eventStoreMicroservice.listen(),
    ]);

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    eventStore = new EventStoreE2ESpecDataSource({
      type: 'mysql',
      url: process.env.EVENTSTORE_DATABASE_URL!,
      timezone: 'Z',
    });
    await eventStore.initialize();

    retailDb = new IdempotencyE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await retailDb.initialize();

    const adminLogin = await server()
      .post('/api/auth/staff/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminAuth = `Bearer ${(adminLogin.body as ITokenResponse).accessToken}`;

    const customerLogin = await server()
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    customerToken = (customerLogin.body as ITokenResponse).accessToken;

    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Idem Place ${stamp}`,
        slug: `e2e-idem-place-${stamp}`,
        description: 'idempotent place fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-IDEMPL-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    variantId = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variantId}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });
    expect(priceRes.status).toBe(HttpStatus.CREATED);

    await settleTimestampRounding();

    const publishRes = await server()
      .post(`/api/catalog/products/${productId}/publish`)
      .set('Authorization', adminAuth);
    expect(publishRes.status).toBe(HttpStatus.OK);

    await waitForStockRow(variantId);

    const receiveRes = await server()
      .post(`/api/inventory/variants/${variantId}/stock/receive`)
      .set('Authorization', adminAuth)
      .send({ quantity: 10 });
    expect(receiveRes.status).toBe(HttpStatus.OK);

    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    cartId = (create.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: 2 });
    expect(add.status).toBe(HttpStatus.OK);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await eventStoreMicroservice?.close();
    await eventStore?.destroy();
    await retailDb?.destroy();
  });

  it('the first place creates the order (201, no replay header)', async () => {
    const res = await place(idempotencyKey);
    expect(res.status).toBe(HttpStatus.CREATED);
    expect(res.headers['idempotent-replay']).toBeUndefined();

    firstOrder = res.body as IOrderBody;
    expect(firstOrder.id).toEqual(expect.any(Number));
    expect(firstOrder.status).toBe('pending');

    await waitForPlacedEvent(firstOrder.id);
  });

  it('the second place with the same key + body replays the same order (200 + Idempotent-Replay)', async () => {
    const res = await place(idempotencyKey);

    // The replay: HTTP 200 (a fresh place was 201) + the replay header, same order id, no
    // second side effect.
    expect(res.status).toBe(HttpStatus.OK);
    expect(res.headers['idempotent-replay']).toBe('true');
    expect((res.body as IOrderBody).id).toBe(firstOrder.id);
  });

  it('exactly one order exists for the cart despite the replay', async () => {
    expect(await retailDb.countOrdersBySourceCartId(cartId)).toBe(1);
  });

  it('exactly one retail.order.placed domain_event row is captured (the replay emitted nothing)', async () => {
    // Settle so any (erroneous) second emission would have been ingested before the count.
    await settleTimestampRounding();
    const placedEvents = await eventStore.countDomainEventsByTypeAndAggregateId(
      KEY_ORDER_PLACED,
      String(firstOrder.id),
    );
    expect(placedEvents).toBe(1);
  });
});
