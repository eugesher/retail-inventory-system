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

// Partial shipment across two fulfillments (ADR-031). A two-line order (one variant
// per line) is split into TWO fulfillments, each covering one line in full. Shipping
// them one at a time proves the order's `fulfillmentStatus` roll-up: it is
// `partially-shipped` while only one line has shipped, and flips to `shipped` only
// once the SECOND fulfillment ships — the roll-up is derived from the order's shipped
// fulfillments' line quantities, not from a single fulfillment. Per-line status tracks
// alongside (`shipped` for a shipped line, `allocated` for one still pending).
//
// Asserted through PUBLIC state (the order GET + the public stock read) — never an
// event spy. Each shipped line leaves its own `sale` movement on its own variant, so
// the per-line decrement is observable per-variant.
//
// Self-provisioned, disjoint fixtures (`e2e-ful-partial-*`): two own variants, so the
// shared seeded variants are never touched.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';

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

interface IStockLevelBody {
  stockLocationId: string;
  quantityOnHand: number;
  quantityAllocated: number;
  quantityReserved: number;
  available: number;
}

interface IVariantStockBody {
  variantId: number;
  totalOnHand: number;
  totalAvailable: number;
  locations: IStockLevelBody[];
}

interface ICartBody {
  id: string;
}

interface IOrderLineBody {
  id: number;
  variantId: number;
  quantity: number;
  status: string;
}

interface IOrderBody {
  id: number;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  lines: IOrderLineBody[];
}

interface IFulfillmentBody {
  id: number;
  orderId: number;
  status: string;
}

describe('Fulfillment partial ship: two fulfillments, one line each (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let customerToken: string;

  let variantA: number;
  let variantB: number;
  let cartId: string;
  let order: IOrderBody;
  let lineAId: number;
  let lineBId: number;
  let fulfillmentAId: number;
  let fulfillmentBId: number;

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
        name: `E2E Fulfillment Partial ${label} ${stamp}`,
        slug: `e2e-ful-partial-${label}-${stamp}`,
        description: 'partial-ship fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-FULPART-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

  const warehouseLevel = async (variant: number): Promise<IStockLevelBody> => {
    const { body } = await server().get(`/api/inventory/variants/${variant}/stock`);
    const stock = body as IVariantStockBody;
    return (
      stock.locations.find((l) => l.stockLocationId === DEFAULT_WAREHOUSE) ?? {
        stockLocationId: DEFAULT_WAREHOUSE,
        quantityOnHand: 0,
        quantityAllocated: 0,
        quantityReserved: 0,
        available: 0,
      }
    );
  };

  const getOrder = async (orderId: number): Promise<IOrderBody> => {
    const { body } = await server().get(`/api/orders/${orderId}`).set('Authorization', adminAuth);
    return body as IOrderBody;
  };

  const lineStatus = (o: IOrderBody, lineId: number): string =>
    o.lines.find((l) => l.id === lineId)!.status;

  const createFulfillment = async (orderLineId: number): Promise<number> => {
    const res = await server()
      .post(`/api/orders/${order.id}/fulfillments`)
      .set('Authorization', adminAuth)
      .send({ lines: [{ orderLineId, quantity: 1 }] });
    expect(res.status).toBe(HttpStatus.CREATED);
    return (res.body as IFulfillmentBody).id;
  };

  const shipFulfillment = async (fulfillmentId: number, tracking: string): Promise<void> => {
    const res = await server()
      .post(`/api/orders/${order.id}/fulfillments/${fulfillmentId}/ship`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `ful-partial-${stamp}-${fulfillmentId}`)
      .send({ trackingNumber: tracking, carrier: 'UPS' });
    expect(res.status).toBe(HttpStatus.OK);
    expect((res.body as IFulfillmentBody).status).toBe('shipped');
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
    customerToken = await customerLogin(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

    variantA = await provisionVariant('a', 5);
    variantB = await provisionVariant('b', 5);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('places a two-line order (one variant per line): unfulfilled, both lines allocated', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    cartId = (create.body as ICartBody).id;

    for (const variant of [variantA, variantB]) {
      const add = await server()
        .post(`/api/cart/${cartId}/lines`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ variantId: variant, quantity: 1 });
      expect(add.status).toBe(HttpStatus.OK);
    }

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `ful-partial-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);

    order = place.body as IOrderBody;
    expect(order.fulfillmentStatus).toBe('unfulfilled');
    expect(order.lines).toHaveLength(2);
    lineAId = order.lines.find((l) => l.variantId === variantA)!.id;
    lineBId = order.lines.find((l) => l.variantId === variantB)!.id;
    expect(lineStatus(order, lineAId)).toBe('allocated');
    expect(lineStatus(order, lineBId)).toBe('allocated');
  });

  it('creates two separate fulfillments, one per line — both pending, order still unfulfilled', async () => {
    fulfillmentAId = await createFulfillment(lineAId);
    fulfillmentBId = await createFulfillment(lineBId);
    expect(fulfillmentAId).not.toBe(fulfillmentBId);

    const list = await server()
      .get(`/api/orders/${order.id}/fulfillments`)
      .set('Authorization', adminAuth);
    expect(list.status).toBe(HttpStatus.OK);
    const fulfillments = list.body as IFulfillmentBody[];
    expect(fulfillments).toHaveLength(2);
    expect(fulfillments.every((f) => f.status === 'pending')).toBe(true);

    // Planning two shipments does not advance the order: still unfulfilled.
    expect((await getOrder(order.id)).fulfillmentStatus).toBe('unfulfilled');
  });

  it('ships the FIRST fulfillment → order is partially-shipped (line A shipped, line B allocated)', async () => {
    await shipFulfillment(fulfillmentAId, '1Z999AA10123456001');

    const fresh = await getOrder(order.id);
    // The roll-up reflects ONE shipped line out of two.
    expect(fresh.fulfillmentStatus).toBe('partially-shipped');
    expect(lineStatus(fresh, lineAId)).toBe('shipped');
    expect(lineStatus(fresh, lineBId)).toBe('allocated');
    // The order lifecycle stays `pending`; payment captured on the first ship.
    expect(fresh.status).toBe('pending');
    expect(fresh.paymentStatus).toBe('captured');

    // Only variant A's stock decremented; variant B still allocated, not shipped.
    const levelA = await warehouseLevel(variantA);
    expect(levelA.quantityOnHand).toBe(4);
    expect(levelA.quantityAllocated).toBe(0);
    const levelB = await warehouseLevel(variantB);
    expect(levelB.quantityOnHand).toBe(5);
    expect(levelB.quantityAllocated).toBe(1);
  });

  it('ships the SECOND fulfillment → order rolls up to shipped (both lines shipped)', async () => {
    await shipFulfillment(fulfillmentBId, '1Z999AA10123456002');

    const fresh = await getOrder(order.id);
    // Now every line has shipped, so the roll-up flips from partially-shipped → shipped.
    expect(fresh.fulfillmentStatus).toBe('shipped');
    expect(lineStatus(fresh, lineAId)).toBe('shipped');
    expect(lineStatus(fresh, lineBId)).toBe('shipped');
    expect(fresh.status).toBe('pending');
    expect(fresh.paymentStatus).toBe('captured');

    // Variant B's stock now decremented too.
    const levelB = await warehouseLevel(variantB);
    expect(levelB.quantityOnHand).toBe(4);
    expect(levelB.quantityAllocated).toBe(0);
  });
});
