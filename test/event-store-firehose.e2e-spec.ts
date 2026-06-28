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
import { InventoryAutoInitE2ESpecDataSource } from './data-source/inventory-auto-init.e2e-spec.data-source';

// Proves the `ris.events` firehose end-to-end (ADR-035): a real Place Order driven
// through the gateway dual-publishes its whole event chain onto the topic exchange,
// the event store's `event_store_firehose_queue` (bound `#`) consumes it, and the
// `FirehoseConsumer` ingests each event into the isolated `ris_eventstore.domain_event`
// log. The suite asserts the persisted rows directly by SQL — there is no query
// endpoint (a deferred capability).
//
// The whole flow (cart create → add line → place) is driven under ONE fixed
// `x-correlation-id` header. The gateway's `CorrelationMiddleware` honors an inbound
// header, and every producer threads the correlation id into the wire event (and
// across the retail→inventory RPC), so the entire chain lands in `domain_event` under
// that single correlation id — making "the order chain shares one correlation_id" a
// deterministic assertion rather than a race.
//
// Ingestion is asynchronous (publish → broker → consume → insert), so the suite polls
// `domain_event` until the expected routing keys appear, up to a bounded timeout.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const CORRELATION_HEADER = 'x-correlation-id';

// The routing keys the Place Order chain dual-publishes onto `ris.events`. Each becomes
// a `domain_event.event_type` verbatim (the ingest stores the routing key as the type).
const KEY_CART_CREATED = 'retail.cart.created';
const KEY_CART_LINE_ADDED = 'retail.cart.line-added';
const KEY_ORDER_PLACED = 'retail.order.placed';
const KEY_PAYMENT_AUTHORIZED = 'retail.payment.authorized';
const KEY_STOCK_RESERVED = 'inventory.stock.reserved';
const KEY_STOCK_ALLOCATED = 'inventory.stock.allocated';
const KEY_AUDIT_STAFF_ACTION = 'audit.staff.action';

const EXPECTED_CHAIN_KEYS = [
  KEY_CART_CREATED,
  KEY_CART_LINE_ADDED,
  KEY_STOCK_RESERVED,
  KEY_ORDER_PLACED,
  KEY_PAYMENT_AUTHORIZED,
  KEY_STOCK_ALLOCATED,
];

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
  orderNumber: string;
  status: string;
}

describe('Event store firehose captures a Place Order chain (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let eventStoreMicroservice: INestMicroservice;
  let eventStore: EventStoreE2ESpecDataSource;
  let retailDb: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  const correlationId = `fh-${stamp}-${randomUUID()}`;
  let adminAuth: string;
  let customerToken: string;
  let variantId: number;
  let cartId: string;
  let placed: IOrderBody;

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

  // Poll `domain_event` (by the chain's shared correlation id) until every expected
  // routing key has been ingested, or fail the suite on timeout. Ingestion is off the
  // bus and asynchronous, so an immediate read after `place` would flake.
  const waitForChainKeys = async (deadlineMs = 30_000): Promise<void> => {
    const start = Date.now();
    for (;;) {
      const rows = await eventStore.getDomainEventsByCorrelationId(correlationId);
      const present = new Set(rows.map((r) => r.eventType));
      if (EXPECTED_CHAIN_KEYS.every((k) => present.has(k))) {
        return;
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(
          `Timed out waiting for the firehose chain. Present: [${[...present].join(', ')}]`,
        );
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

    // The event store binds the firehose queue to the `ris.events` TOPIC exchange with
    // the `#` catch-all + `wildcards: true` — the same shape as its `main.ts`, so the
    // in-process `FirehoseConsumer` receives the entire firehose.
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

    retailDb = new InventoryAutoInitE2ESpecDataSource({
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

    // Self-provisioned, disjoint fixture — its own product/price/published/received
    // stock, so the shared seeded variants are untouched.
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Firehose ${stamp}`,
        slug: `e2e-firehose-${stamp}`,
        description: 'firehose fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-FH-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

  it('drives a full Place Order under one correlation id and ingests the chain', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .set(CORRELATION_HEADER, correlationId)
      .send({ currency: 'USD' });
    expect(create.status).toBe(HttpStatus.CREATED);
    cartId = (create.body as ICartBody).id;

    const addLine = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set(CORRELATION_HEADER, correlationId)
      .send({ variantId, quantity: 2 });
    expect(addLine.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set(CORRELATION_HEADER, correlationId)
      .set('Idempotency-Key', `fh-${stamp}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    placed = place.body as IOrderBody;
    expect(placed.status).toBe('pending');

    await waitForChainKeys();
  });

  it('persists every chain routing key as a domain_event under the shared correlation id', async () => {
    const rows = await eventStore.getDomainEventsByCorrelationId(correlationId);
    const eventTypes = new Set(rows.map((r) => r.eventType));

    for (const key of EXPECTED_CHAIN_KEYS) {
      expect(eventTypes).toContain(key);
    }

    // The correlation id is the firehose chain's join key: every captured row carries it.
    expect(rows.every((r) => r.correlationId === correlationId)).toBe(true);
  });

  it('populates producer / aggregate_type / aggregate_id from the resolvers', async () => {
    const rows = await eventStore.getDomainEventsByCorrelationId(correlationId);
    const byType = (type: string): (typeof rows)[number] => {
      const row = rows.find((r) => r.eventType === type);
      if (!row) {
        throw new Error(`No domain_event row for ${type}`);
      }
      return row;
    };

    // producer ← first routing-key token mapped to the service name; aggregate_type ←
    // the second token; aggregate_id ← the documented payload-key precedence.
    const orderPlaced = byType(KEY_ORDER_PLACED);
    expect(orderPlaced.producer).toBe('retail-microservice');
    expect(orderPlaced.aggregateType).toBe('order');
    expect(orderPlaced.aggregateId).toBe(String(placed.id));
    expect(orderPlaced.eventVersion).toBeTruthy();

    const paymentAuthorized = byType(KEY_PAYMENT_AUTHORIZED);
    expect(paymentAuthorized.producer).toBe('retail-microservice');
    expect(paymentAuthorized.aggregateType).toBe('payment');

    const stockReserved = byType(KEY_STOCK_RESERVED);
    expect(stockReserved.producer).toBe('inventory-microservice');
    expect(stockReserved.aggregateType).toBe('stock');
    expect(stockReserved.aggregateId).not.toHaveLength(0);

    const stockAllocated = byType(KEY_STOCK_ALLOCATED);
    expect(stockAllocated.producer).toBe('inventory-microservice');
    expect(stockAllocated.aggregateType).toBe('stock');

    const cartCreated = byType(KEY_CART_CREATED);
    expect(cartCreated.producer).toBe('retail-microservice');
    expect(cartCreated.aggregateType).toBe('cart');
  });

  it('orders the chain sanely by occurred_at (cart precedes the placed order)', async () => {
    const rows = await eventStore.getDomainEventsByCorrelationId(correlationId);
    const cartCreated = rows.find((r) => r.eventType === KEY_CART_CREATED)!;
    const orderPlaced = rows.find((r) => r.eventType === KEY_ORDER_PLACED)!;

    const cartTime = new Date(cartCreated.occurredAt).getTime();
    const placedTime = new Date(orderPlaced.occurredAt).getTime();
    expect(Number.isNaN(cartTime)).toBe(false);
    expect(Number.isNaN(placedTime)).toBe(false);
    expect(placedTime).toBeGreaterThanOrEqual(cartTime);
  });

  it('never writes audit.staff.action into domain_event (it routes only to audit_log_entry)', async () => {
    // The admin login earlier in the suite emitted `audit.staff.action`, so this is a
    // live negative: the audit stream exists on the bus but the domain-event log must
    // stay clean of it (ADR-035 keeps the two logs distinct).
    const audited = await eventStore.countDomainEventsByEventType(KEY_AUDIT_STAFF_ACTION);
    expect(audited).toBe(0);
  });
});
