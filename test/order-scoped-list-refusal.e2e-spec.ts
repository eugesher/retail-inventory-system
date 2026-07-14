import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { InventoryAutoInitE2ESpecDataSource } from './data-source/inventory-auto-init.e2e-spec.data-source';

// THE assertion ADR-051 exists for, and the one that did not exist before it: **the three
// order-scoped, owner-or-staff lists give a non-owner the SAME answer.**
//
// They did not. `/returns` filtered its rows and handed a stranger `[]` with a `200`, while
// `/refunds` and `/fulfillments` refused with a `403`. A client could not write one error handler
// for one shape of request, and the next list endpoint's author would have copied whichever sibling
// they happened to open. Nothing recorded which was intended — so this spec records it, in the only
// place a rule survives: a test that fails if the codebase drifts back.
//
// **It is deliberately fixture-light.** No returns and no refunds are created: the question is what
// a NON-OWNER gets, and the answer must not depend on whether the order has anything to show. That
// independence is the subtle half of ADR-051 — the old `.filter()` refused nothing, so an order with
// no RMAs and an order with RMAs both answered `[]`, and the endpoint still told a stranger *whether
// the order had returns*. An order and a second customer are the whole fixture.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const OWNER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

const ADDRESS = {
  recipientName: 'List Refusal',
  line1: '1 Market St',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94105',
  country: 'US',
};

interface ITokenResponse {
  accessToken: string;
}

describe('Order-scoped lists refuse a non-owner identically (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let ownerToken: string;
  let strangerToken: string;
  let orderId: number;

  // The three order-scoped, owner-or-staff lists. `/returns` is served by the returns module,
  // `/refunds` and `/fulfillments` by orders — three files, one rule (ADR-051).
  const listRoutes = (id: number): string[] => [
    `/api/orders/${id}/returns`,
    `/api/orders/${id}/refunds`,
    `/api/orders/${id}/fulfillments`,
  ];

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const customerLogin = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/customer/login').send({ email, password });
    return (body as ITokenResponse).accessToken;
  };

  const registerCustomer = async (): Promise<string> => {
    const email = `stranger-${stamp}@example.com`;
    await server().post('/api/auth/customer/register').send({ email, password: CUSTOMER_PASSWORD });
    return customerLogin(email, CUSTOMER_PASSWORD);
  };

  // The pricing publish probe compares `price.valid_from` against a second-granular
  // `UTC_TIMESTAMP()`; publishing immediately after the price lands can miss it.
  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  // `stock_level` is created asynchronously by the catalog-variant-created consumer.
  const waitForStockRow = async (variantId: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRows(variantId)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variantId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const provisionVariant = async (onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E List Refusal ${stamp}`,
        slug: `e2e-list-refusal-${stamp}`,
        description: 'ADR-051 fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-LREF-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variantId = (variantRes.body as { id: number }).id;

    await server()
      .post(`/api/catalog/variants/${variantId}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });

    await settleTimestampRounding();
    await server()
      .post(`/api/catalog/products/${productId}/publish`)
      .set('Authorization', adminAuth);

    await waitForStockRow(variantId);

    await server()
      .post(`/api/inventory/variants/${variantId}/stock/receive`)
      .set('Authorization', adminAuth)
      .send({ quantity: onHand });

    return variantId;
  };

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

    catalogMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      CatalogMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          queue: MicroserviceQueueEnum.CATALOG_QUEUE,
          queueOptions: { durable: true },
        },
      },
    );
    await catalogMicroservice.listen();

    inventoryMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      InventoryMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          queue: MicroserviceQueueEnum.INVENTORY_QUEUE,
          queueOptions: { durable: true },
        },
      },
    );
    await inventoryMicroservice.listen();

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    dataSource = new InventoryAutoInitE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);
    ownerToken = await customerLogin(OWNER_EMAIL, CUSTOMER_PASSWORD);
    strangerToken = await registerCustomer();

    // One order, owned by `customer@example.com`. It is never shipped and never refunded — the
    // lists are all legitimately EMPTY for its owner, which is exactly what makes the non-owner's
    // answer meaningful.
    const variantId = await provisionVariant(5);

    const cartRes = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ currency: 'USD' });
    const cartId = (cartRes.body as { id: string }).id;

    await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ variantId, quantity: 1 });

    const placeRes = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `list-refusal-${stamp}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(placeRes.status).toBe(HttpStatus.CREATED);
    orderId = (placeRes.body as { id: number }).id;
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  // **The assertion the whole ADR is for.** Before ADR-051 this failed on `/returns`, which answered
  // `200` with `[]` while its two siblings answered `403` — the same request, three routes, two
  // answers.
  it('gives a non-owner the SAME refusal on all three lists — 403, never an empty list', async () => {
    const responses = await Promise.all(
      listRoutes(orderId).map((route) =>
        server()
          .get(route)
          .set('Authorization', `Bearer ${strangerToken}`)
          .then((res) => ({ route, status: res.status, body: res.body as unknown })),
      ),
    );

    for (const { route, status, body } of responses) {
      expect({ route, status }).toEqual({ route, status: HttpStatus.FORBIDDEN as number });
      // And emphatically NOT an empty list dressed up as success.
      expect(body).not.toEqual([]);
    }

    // Stated as the invariant rather than three separate facts: one answer, three routes.
    expect(new Set(responses.map((r) => r.status)).size).toBe(1);
  });

  it('serves the owner on all three lists — empty, because this order has no returns, refunds or fulfillments', async () => {
    for (const route of listRoutes(orderId)) {
      const res = await server().get(route).set('Authorization', `Bearer ${ownerToken}`);

      expect({ route, status: res.status }).toEqual({ route, status: HttpStatus.OK as number });
      expect(res.body).toEqual([]);
    }
  });

  it('serves staff on all three lists', async () => {
    for (const route of listRoutes(orderId)) {
      const res = await server().get(route).set('Authorization', adminAuth);

      expect({ route, status: res.status }).toEqual({ route, status: HttpStatus.OK as number });
      expect(res.body).toEqual([]);
    }
  });

  // A missing order is a 404 on all three — the other half of ADR-051's rule: `403` = not yours,
  // `404` = not there. The two are distinct answers to distinct questions, and the ADR accepts that
  // they are distinguishable.
  it('404s on all three lists for an order that does not exist', async () => {
    for (const route of listRoutes(999_999_999)) {
      const res = await server().get(route).set('Authorization', adminAuth);

      expect({ route, status: res.status }).toEqual({
        route,
        status: HttpStatus.NOT_FOUND as number,
      });
    }
  });
});
