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

// `GET /api/audit/trace/:correlationId` — the third operator question: "what did THIS
// request cause?" (ADR-039). It reassembles both event-store logs for one correlation id:
// `events` from `domain_event` and `auditEntries` from `audit_log_entry`.
//
// TWO TIMELINES, NEVER MERGED. They answer different questions and their ids live in
// different spaces, so the route returns two arrays rather than one interleaved stream.
// Both read FORWARD (`occurredAt` ascending, `id` ascending for ties) — the opposite of
// the two list routes, which read newest-first. A trace is a story; a list is an inbox.
//
// EMPTY IS NOT MISSING. An unknown correlation id is `200 { events: [], auditEntries: [] }`,
// never a `404`: the absence of a trace is not the absence of a resource. That is the one
// assertion an operator's tooling depends on and the one a well-meaning refactor breaks.
//
// NO ASSERTION ON `auditEntries.length`. `audit_log_entry` has no dedupe key, so an
// at-least-once redelivery of an `audit.staff.action` message appends another identical
// row. `domain_event` carries a composite UNIQUE and swallows its duplicate at ingest;
// the audit log does not. The suite asserts the CONTENT of every returned row, never a count.
//
// The suite drives one Place Order and one staff action under the SAME `x-correlation-id`,
// so both logs have something to say about the same request.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const ADMIN_STAFF_USER_ID = '00000000-0000-4000-a000-000000000001';
const WAREHOUSE_EMAIL = 'warehouse@example.com';
const WAREHOUSE_PASSWORD = 'warehouse1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const TARGET_STAFF_USER_ID = '00000000-0000-4000-a000-000000000004';
const TARGET_SEED_ROLE = 'warehouse-staff';
const CORRELATION_HEADER = 'x-correlation-id';

const KEY_CART_CREATED = 'retail.cart.created';
const KEY_ORDER_PLACED = 'retail.order.placed';
const KEY_PAYMENT_AUTHORIZED = 'retail.payment.authorized';
const ASSIGN_ROLE_ACTION = 'StaffUserRolesAssigned';
// `audit.staff.action` is the one routing key the firehose diverts away from the
// domain-event ingest; it must never appear among the traced `events`.
const KEY_AUDIT_STAFF_ACTION = 'audit.staff.action';

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

interface ITimelineRow {
  id: number;
  correlationId: string | null;
  occurredAt: string;
}

interface IDomainEventItem extends ITimelineRow {
  eventType: string;
  producer: string;
  aggregateId: string;
}

interface IAuditLogEntryItem extends ITimelineRow {
  action: string;
  actorId: string | null;
  actorType: string;
}

interface ITraceBody {
  events: IDomainEventItem[];
  auditEntries: IAuditLogEntryItem[];
}

// Assert a timeline reads forward: `occurredAt` ascending, ties broken on ascending `id`.
const assertAscending = (rows: ITimelineRow[]): void => {
  for (let i = 1; i < rows.length; i++) {
    const previousAt = new Date(rows[i - 1].occurredAt).getTime();
    const currentAt = new Date(rows[i].occurredAt).getTime();
    expect(Number.isNaN(previousAt)).toBe(false);
    expect(previousAt).toBeLessThanOrEqual(currentAt);
    if (previousAt === currentAt) {
      expect(rows[i - 1].id).toBeLessThan(rows[i].id);
    }
  }
};

describe('GET /api/audit/trace/:correlationId — both logs, one request (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let eventStoreApp: INestApplication;

  const stamp = Date.now();
  const correlationId = `audit-trace-${stamp}-${randomUUID()}`;

  let adminAuth: string;
  let warehouseAuth: string;
  let customerToken: string;
  let variantId: number;
  let orderId: number;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const trace = async (
    targetCorrelationId: string,
    auth: string = adminAuth,
  ): Promise<supertest.Response> =>
    server().get(`/api/audit/trace/${targetCorrelationId}`).set('Authorization', auth);

  // Both logs are written asynchronously off the bus, so poll until each has a row.
  const waitForBothLogs = async (deadlineMs = 30_000): Promise<ITraceBody> => {
    const start = Date.now();
    for (;;) {
      const res = await trace(correlationId);
      expect(res.status).toBe(HttpStatus.OK);
      const body = res.body as ITraceBody;
      if (body.events.length > 0 && body.auditEntries.length > 0) {
        return body;
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(
          `Timed out waiting for both logs under ${correlationId}: ` +
            `${body.events.length} events / ${body.auditEntries.length} audit entries`,
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

    // The hybrid boot of the event store's `main.ts`: firehose (ingest) + query queue (RPC),
    // `init()` first, `listen()` never.
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
        name: `E2E Audit Trace ${stamp}`,
        slug: `e2e-audit-trace-${stamp}`,
        description: 'audit trace fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-ATR-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

    // The domain-event half of the trace: a full Place Order under the traced id.
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
      .set('Idempotency-Key', `audit-trace-${stamp}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    orderId = (place.body as { id: number }).id;

    // The audit-log half: one staff action under the SAME id. Re-assigning the seeded role
    // is a valid, non-mutating call whose audit publish is unconditional.
    const assign = await server()
      .post(`/api/iam/staff/${TARGET_STAFF_USER_ID}/roles`)
      .set('Authorization', adminAuth)
      .set(CORRELATION_HEADER, correlationId)
      .send({ roleNames: [TARGET_SEED_ROLE] });
    expect(assign.status).toBe(HttpStatus.OK);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await eventStoreApp?.close();
  });

  it('returns both logs for one correlation id', async () => {
    const body = await waitForBothLogs();

    expect(body.events.some((event) => event.eventType === KEY_ORDER_PLACED)).toBe(true);
    expect(body.auditEntries.some((entry) => entry.action === ASSIGN_ROLE_ACTION)).toBe(true);

    // The two logs stay distinct: `audit.staff.action` rides the firehose into
    // `audit_log_entry` alone and never lands among the domain events.
    expect(body.events.some((event) => event.eventType === KEY_AUDIT_STAFF_ACTION)).toBe(false);
  });

  it('orders each timeline forward — occurredAt ascending, id ascending on ties', async () => {
    const body = await waitForBothLogs();

    assertAscending(body.events);
    assertAscending(body.auditEntries);

    // Read forward, the chain is a story with the causality intact: the cart is opened
    // before the order is placed, and the order is placed before its payment is authorized.
    const at = (eventType: string): number =>
      body.events.findIndex((event) => event.eventType === eventType);
    expect(at(KEY_CART_CREATED)).toBeGreaterThanOrEqual(0);
    expect(at(KEY_CART_CREATED)).toBeLessThan(at(KEY_ORDER_PLACED));
    expect(at(KEY_ORDER_PLACED)).toBeLessThan(at(KEY_PAYMENT_AUTHORIZED));

    // The placed order is this suite's order, not a neighbour's — the correlation id is
    // the join key, and it scopes exactly one request.
    const placed = body.events[at(KEY_ORDER_PLACED)];
    expect(placed.producer).toBe('retail-microservice');
    expect(placed.aggregateId).toBe(String(orderId));
  });

  it('every returned row belongs to the traced id', async () => {
    const body = await waitForBothLogs();

    for (const event of body.events) {
      expect(event.correlationId).toBe(correlationId);
    }
    for (const entry of body.auditEntries) {
      expect(entry.correlationId).toBe(correlationId);
      // The staff action was the admin's; nothing else was performed under this id.
      expect(entry.actorId).toBe(ADMIN_STAFF_USER_ID);
      expect(entry.actorType).toBe('staff-user');
    }
  });

  it('an unknown correlation id is 200 with two empty arrays — never 404', async () => {
    const res = await trace(`does-not-exist-${randomUUID()}`);

    expect(res.status).toBe(HttpStatus.OK);
    expect(res.body).toEqual({ events: [], auditEntries: [] });
  });

  it('a missing id 404s from routing; a whitespace-only id 400s from the handler', async () => {
    // A bare `/audit/trace/` matches no route at all. A whitespace segment DOES reach the
    // handler, and must be rejected: `domain_event.correlation_id` is `NOT NULL DEFAULT ''`,
    // so an empty target would ask for the bucket of every event ingested WITHOUT a
    // correlation id rather than for nothing.
    const missing = await server().get('/api/audit/trace/').set('Authorization', adminAuth);
    expect(missing.status).toBe(HttpStatus.NOT_FOUND);

    const blank = await server().get('/api/audit/trace/%20').set('Authorization', adminAuth);
    expect(blank.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('gates the route on audit:read — a staff token without it gets 403, anonymous gets 401', async () => {
    const forbidden = await trace(correlationId, warehouseAuth);
    expect(forbidden.status).toBe(HttpStatus.FORBIDDEN);

    const customer = await trace(correlationId, `Bearer ${customerToken}`);
    expect(customer.status).toBe(HttpStatus.FORBIDDEN);

    const anonymous = await server().get(`/api/audit/trace/${correlationId}`);
    expect(anonymous.status).toBe(HttpStatus.UNAUTHORIZED);
  });
});
