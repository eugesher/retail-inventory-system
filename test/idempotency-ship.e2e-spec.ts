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

// Idempotent Ship Fulfillment (ADR-036). A ship with an `Idempotency-Key`, replayed with the
// same key + body, returns the stored `FulfillmentView` (HTTP 200 + `Idempotent-Replay: true`)
// BEFORE the ship's side effects — no second shipment, no second capture, and no second
// `commit-sale`. The observable oracle is the inventory ledger: shipping commits the sale
// asynchronously as exactly ONE strictly-negative `sale` `StockMovement` keyed on
// `(reference_type='fulfillment', reference_id=fulfillmentId)`; a replay must leave that at
// one. Two layers guarantee it — the store replay short-circuits before `commit-sale`, and
// `commit-sale` is itself `fulfillmentId`-idempotent (`existsByReference`) as the backstop.
//
// Self-provisioned, disjoint fixture (`e2e-idem-ship-*`).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

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
  paymentStatus: string;
  fulfillmentStatus: string;
  lines: { id: number }[];
  payment?: { capturedAt: string | null };
}

interface IFulfillmentBody {
  id: number;
  status: string;
}

interface IMovementBody {
  id: number;
  type: string;
  quantity: number;
  referenceType: string | null;
  referenceId: string | null;
}

interface IPageBody<T> {
  items: T[];
}

describe('Idempotent Ship Fulfillment: replay does not re-ship or re-commit-sale (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let customerToken: string;
  let variantId: number;
  let order: IOrderBody;
  let fulfillmentId: number;
  let capturedAtAfterShip: string | null;

  const shipKey = `idem-ship-${stamp}`;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const customerLogin = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/customer/login').send({ email, password });
    return (body as ITokenResponse).accessToken;
  };

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const waitForStockRow = async (variant: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRows(variant)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variant}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const provisionVariant = async (label: string, onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Idem Ship ${label} ${stamp}`,
        slug: `e2e-idem-ship-${label}-${stamp}`,
        description: 'idempotent ship fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-IDEMSHIP-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variant = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variant}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });
    expect(priceRes.status).toBe(HttpStatus.CREATED);

    await settleTimestampRounding();

    const publishRes = await server()
      .post(`/api/catalog/products/${productId}/publish`)
      .set('Authorization', adminAuth);
    expect(publishRes.status).toBe(HttpStatus.OK);

    await waitForStockRow(variant);

    const receiveRes = await server()
      .post(`/api/inventory/variants/${variant}/stock/receive`)
      .set('Authorization', adminAuth)
      .send({ quantity: onHand });
    expect(receiveRes.status).toBe(HttpStatus.OK);

    return variant;
  };

  const listMovements = async (variant: number): Promise<IMovementBody[]> => {
    const { body } = await server()
      .get(`/api/inventory/variants/${variant}/movements`)
      .set('Authorization', adminAuth);
    return (body as IPageBody<IMovementBody>).items;
  };

  const saleMovements = async (variant: number): Promise<IMovementBody[]> =>
    (await listMovements(variant)).filter((m) => m.type === 'sale');

  // commit-sale runs AFTER the ship commits (post-commit, retry-then-log), so the sale
  // movement lands asynchronously — poll for it.
  const waitForSaleMovement = async (variant: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await saleMovements(variant)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for the sale movement of variant ${variant}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const ship = (key: string): supertest.Test =>
    server()
      .post(`/api/orders/${order.id}/fulfillments/${fulfillmentId}/ship`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', key)
      .send({ trackingNumber: '1Z999AA10123456789', carrier: 'UPS' });

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
    customerToken = await customerLogin(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

    variantId = await provisionVariant('a', 5);

    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    const cartId = (create.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: 1 });
    expect(add.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `idem-ship-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    order = place.body as IOrderBody;

    const createFul = await server()
      .post(`/api/orders/${order.id}/fulfillments`)
      .set('Authorization', adminAuth)
      .send({ lines: [{ orderLineId: order.lines[0].id, quantity: 1 }] });
    expect(createFul.status).toBe(HttpStatus.CREATED);
    fulfillmentId = (createFul.body as IFulfillmentBody).id;
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('the first ship shipping (200), captures the payment, and commits exactly one sale movement', async () => {
    const res = await ship(shipKey);
    expect(res.status).toBe(HttpStatus.OK);
    expect(res.headers['idempotent-replay']).toBeUndefined();
    expect((res.body as IFulfillmentBody).status).toBe('shipped');

    // Ship-triggered capture flipped the payment axis.
    const fresh = (await server().get(`/api/orders/${order.id}`).set('Authorization', adminAuth))
      .body as IOrderBody;
    expect(fresh.paymentStatus).toBe('captured');
    capturedAtAfterShip = fresh.payment?.capturedAt ?? null;
    expect(capturedAtAfterShip).not.toBeNull();

    await waitForSaleMovement(variantId);
    const sales = await saleMovements(variantId);
    expect(sales).toHaveLength(1);
    expect(sales[0].quantity).toBeLessThan(0);
    expect(sales[0].referenceType).toBe('fulfillment');
    expect(sales[0].referenceId).toBe(String(fulfillmentId));
  });

  it('the replay returns the stored fulfillment (200 + Idempotent-Replay), still shipped', async () => {
    const res = await ship(shipKey);
    expect(res.status).toBe(HttpStatus.OK);
    expect(res.headers['idempotent-replay']).toBe('true');
    expect((res.body as IFulfillmentBody).status).toBe('shipped');
  });

  it('no second sale movement and no re-capture after the replay', async () => {
    // Settle so a (wrong) second commit-sale would have landed before the count.
    await settleTimestampRounding();
    const sales = await saleMovements(variantId);
    expect(sales).toHaveLength(1);

    const fresh = (await server().get(`/api/orders/${order.id}`).set('Authorization', adminAuth))
      .body as IOrderBody;
    expect(fresh.fulfillmentStatus).toBe('shipped');
    // The capture timestamp is unchanged — the replay took no money a second time.
    expect(fresh.payment?.capturedAt).toBe(capturedAtAfterShip);
  });
});
