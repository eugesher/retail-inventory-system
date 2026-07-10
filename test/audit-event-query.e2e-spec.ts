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

// `GET /api/audit/events` — the operator read of the event store's `domain_event`
// firehose log (ADR-039), driven through the gateway against a real Place Order.
//
// The suite answers the capability's actual claim: **one HTTP call reassembles the whole
// causal chain of one request, across every service that produced part of it.** The order
// is placed under a fixed `x-correlation-id`, so the cart events (retail), the reserve /
// allocate events (inventory) and the order / payment events (retail) all land in
// `domain_event` under one id — and `?correlationId=` hands them back together.
//
// THE BOOT. The event store must connect BOTH of its transports: the firehose queue that
// ingests the chain, and `event_store_query_queue` that answers the three `audit.*` RPCs.
// A second transport rules out `NestFactory.createMicroservice` (an `INestMicroservice`
// has no `connectMicroservice`), so the suite mirrors the service's own hybrid `main.ts`:
// `create` → two `connectMicroservice` → `init()` → `startAllMicroservices()`, and never
// `listen()`. Booting only the firehose queue would leave `/api/audit/*` HANGING rather
// than failing: the query queue is durable, so the broker accepts a message nobody
// consumes and the gateway waits forever for a reply.
//
// Ingestion is asynchronous, so the chain is polled for through the query API itself
// rather than read once.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
// `warehouse-staff` bundles the `inventory:*` codes and NOT `audit:read` — the clean 403
// fixture for a staff token that is authenticated but unauthorized.
const WAREHOUSE_EMAIL = 'warehouse@example.com';
const WAREHOUSE_PASSWORD = 'warehouse1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const CORRELATION_HEADER = 'x-correlation-id';

// The routing keys a Place Order dual-publishes onto `ris.events`; each is stored verbatim
// as `domain_event.event_type`. Kept in step with `test/event-store-firehose.e2e-spec.ts`,
// which proves the same chain by reading the table directly.
const KEY_CART_CREATED = 'retail.cart.created';
const KEY_CART_LINE_ADDED = 'retail.cart.line-added';
const KEY_STOCK_RESERVED = 'inventory.stock.reserved';
const KEY_ORDER_PLACED = 'retail.order.placed';
const KEY_PAYMENT_AUTHORIZED = 'retail.payment.authorized';
const KEY_STOCK_ALLOCATED = 'inventory.stock.allocated';

const EXPECTED_CHAIN_KEYS = [
  KEY_CART_CREATED,
  KEY_CART_LINE_ADDED,
  KEY_STOCK_RESERVED,
  KEY_ORDER_PLACED,
  KEY_PAYMENT_AUTHORIZED,
  KEY_STOCK_ALLOCATED,
];

const RETAIL_PRODUCER = 'retail-microservice';
const INVENTORY_PRODUCER = 'inventory-microservice';

// The event store's ceiling, declared in ONE place (its query use case) and inherited by
// every caller. The gateway DTO deliberately carries no `@Max`.
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

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

interface IDomainEventItem {
  id: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  producer: string;
  correlationId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('GET /api/audit/events — the firehose read (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let eventStoreApp: INestApplication;

  const stamp = Date.now();
  const correlationId = `audit-events-${stamp}-${randomUUID()}`;

  let adminAuth: string;
  let warehouseAuth: string;
  let customerToken: string;
  let variantId: number;
  let orderId: number;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const queryEvents = async (
    query: string,
    auth: string = adminAuth,
  ): Promise<supertest.Response> =>
    server().get(`/api/audit/events${query}`).set('Authorization', auth);

  // Poll the query API — not the table — until the chain has been ingested. That makes the
  // read path itself part of the assertion.
  const waitForChain = async (deadlineMs = 30_000): Promise<IDomainEventItem[]> => {
    const start = Date.now();
    for (;;) {
      const res = await queryEvents(`?correlationId=${correlationId}&pageSize=${MAX_PAGE_SIZE}`);
      expect(res.status).toBe(HttpStatus.OK);
      const page = res.body as IPageBody<IDomainEventItem>;
      const present = new Set(page.items.map((item) => item.eventType));
      if (EXPECTED_CHAIN_KEYS.every((key) => present.has(key))) {
        return page.items;
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(
          `Timed out waiting for the chain under ${correlationId}. Present: [${[...present].join(', ')}]`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const waitForStockRow = async (id: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    for (;;) {
      const { body } = await server().get(`/api/inventory/variants/${id}/stock`);
      if ((body as { locations: unknown[] }).locations.length > 0) {
        return;
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for the auto-init stock level of variant ${id}`);
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

    // The event store's hybrid boot, exactly as its `main.ts` does it. `init()` MUST run
    // before `startAllMicroservices()` — `connectMicroservice` marks each transport
    // initialized, so their own `listen()` skips the lifecycle hooks and only `init()`
    // opens the `ris_eventstore` connection. `listen()` is never called: the service has
    // no HTTP surface.
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
    ]);

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    const adminLogin = await server()
      .post('/api/auth/staff/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminAuth = `Bearer ${(adminLogin.body as ITokenResponse).accessToken}`;

    const warehouseLogin = await server()
      .post('/api/auth/staff/login')
      .send({ email: WAREHOUSE_EMAIL, password: WAREHOUSE_PASSWORD });
    warehouseAuth = `Bearer ${(warehouseLogin.body as ITokenResponse).accessToken}`;

    const customerLogin = await server()
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    customerToken = (customerLogin.body as ITokenResponse).accessToken;

    // Self-provisioned, disjoint fixture.
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Audit Events ${stamp}`,
        slug: `e2e-audit-events-${stamp}`,
        description: 'audit event-query fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-AEQ-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

    // The whole flow under ONE correlation id: `CorrelationMiddleware` honours the inbound
    // header and every producer threads it onto the wire event, including across the
    // retail → inventory RPC.
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .set(CORRELATION_HEADER, correlationId)
      .send({ currency: 'USD' });
    expect(create.status).toBe(HttpStatus.CREATED);
    const cartId = (create.body as { id: string }).id;

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
      .set('Idempotency-Key', `audit-events-${stamp}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    orderId = (place.body as { id: number }).id;
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await eventStoreApp?.close();
  });

  it('returns the whole Place Order chain for one correlation id, newest first', async () => {
    const items = await waitForChain();

    const present = new Set(items.map((item) => item.eventType));
    for (const key of EXPECTED_CHAIN_KEYS) {
      expect(present).toContain(key);
    }
    // The filter is exact: nothing from another request leaked into the page.
    expect(items.every((item) => item.correlationId === correlationId)).toBe(true);

    // The two LIST routes read backwards (`occurred_at DESC, id DESC`) — an operator opens
    // them to see what just happened. Only the trace reads forward. `occurred_at` has
    // second granularity here, so ties are broken on the descending id.
    for (let i = 1; i < items.length; i++) {
      const previous = items[i - 1];
      const current = items[i];
      const previousAt = new Date(previous.occurredAt).getTime();
      const currentAt = new Date(current.occurredAt).getTime();
      expect(Number.isNaN(previousAt)).toBe(false);
      expect(previousAt).toBeGreaterThanOrEqual(currentAt);
      if (previousAt === currentAt) {
        expect(previous.id).toBeGreaterThan(current.id);
      }
    }
  });

  it('the chain spans more than one producing service', async () => {
    const items = await waitForChain();
    const producers = new Set(items.map((item) => item.producer));

    // The capability's actual claim: reassembling a request means crossing service
    // boundaries, not reading one service's log.
    expect(producers).toContain(RETAIL_PRODUCER);
    expect(producers).toContain(INVENTORY_PRODUCER);
    expect(producers.size).toBeGreaterThanOrEqual(2);
  });

  it('pairs aggregateType with aggregateId, returning only that order’s own events', async () => {
    const res = await queryEvents(`?aggregateType=order&aggregateId=${orderId}`);
    expect(res.status).toBe(HttpStatus.OK);
    const page = res.body as IPageBody<IDomainEventItem>;

    expect(page.items.length).toBeGreaterThanOrEqual(1);
    for (const item of page.items) {
      expect(item.aggregateType).toBe('order');
      expect(item.aggregateId).toBe(String(orderId));
    }
    // `aggregate_type` is the routing key's SECOND token, so this order's payment /
    // allocation events are filed under `payment` / `stock` against their own ids — the
    // aggregate filter is per-token, and the correlation filter is what reunites them.
    expect(page.items.some((item) => item.eventType === KEY_ORDER_PLACED)).toBe(true);
    expect(page.items.some((item) => item.eventType === KEY_PAYMENT_AUTHORIZED)).toBe(false);
  });

  it('clamps pageSize to the event store ceiling, and defaults the window', async () => {
    const capped = await queryEvents(`?pageSize=500`);
    expect(capped.status).toBe(HttpStatus.OK);
    const cappedPage = capped.body as IPageBody<IDomainEventItem>;
    // The cap lives in the event store's use case, in ONE place: a direct RPC caller that
    // never passes through this gateway inherits it too. The gateway DTO has no `@Max`.
    expect(cappedPage.size).toBe(MAX_PAGE_SIZE);
    expect(cappedPage.items.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);

    const bare = await queryEvents('');
    expect(bare.status).toBe(HttpStatus.OK);
    const barePage = bare.body as IPageBody<IDomainEventItem>;
    expect(barePage.page).toBe(1);
    expect(barePage.size).toBe(DEFAULT_PAGE_SIZE);
  });

  it('rejects a transposed from/to window with 400 rather than answering an empty page', async () => {
    // The event store reads an inverted `BETWEEN` as the empty set, so the DTO is the only
    // place an operator's transposed dates surface as an error instead of as "nothing
    // happened".
    const res = await queryEvents(`?from=2030-01-01T00:00:00.000Z&to=2020-01-01T00:00:00.000Z`);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('gates the route on audit:read — a staff token without it gets 403, anonymous gets 401', async () => {
    const forbidden = await queryEvents('', warehouseAuth);
    expect(forbidden.status).toBe(HttpStatus.FORBIDDEN);

    // A customer JWT carries no `permissions` claim at all, so a code-gated route is
    // staff-only by construction (ADR-024).
    const customer = await queryEvents('', `Bearer ${customerToken}`);
    expect(customer.status).toBe(HttpStatus.FORBIDDEN);

    const anonymous = await server().get('/api/audit/events');
    expect(anonymous.status).toBe(HttpStatus.UNAUTHORIZED);
  });
});
