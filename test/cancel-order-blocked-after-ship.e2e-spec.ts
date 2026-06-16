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

// Cancel Order is BLOCKED once stock has physically shipped (ADR-031). After a
// fulfillment ships, the order's lifecycle axis still reads `pending` (Ship advances
// only the fulfillment axis), so the real guard is NOT the `Order.cancel()` lifecycle
// check — it is the use case's fulfillment-presence check: an order with a
// `shipped`/`delivered` fulfillment cannot be cancelled, because cancelling would
// strand physically-shipped stock. The rejection is about ORDER STATE, not
// authorization, so even a staff `order:cancel` token gets `409 ORDER_NOT_CANCELLABLE`.
//
// Asserted through PUBLIC state (the order GET + the public stock read): the rejected
// cancel changes NOTHING — the order keeps its shipped/captured state and the shipped
// stock stays decremented, with no `release` row appended.
//
// Self-provisioned, disjoint fixture (`e2e-cancel-ship-*`): its own variant, so the
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

interface IOrderBody {
  id: number;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  lines: { id: number; variantId: number; quantity: number; status: string }[];
}

interface IFulfillmentBody {
  id: number;
  status: string;
}

interface IMovementBody {
  id: number;
  type: string;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Cancel Order blocked after ship: 409 ORDER_NOT_CANCELLABLE (e2e)', () => {
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
  let cartId: string;
  let order: IOrderBody;
  let fulfillmentId: number;

  const ORDERED_QTY = 2;
  const RECEIVED_QTY = 5;

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
        name: `E2E Cancel Ship ${label} ${stamp}`,
        slug: `e2e-cancel-ship-${label}-${stamp}`,
        description: 'cancel-blocked-after-ship fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-CANSHIP-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

  const listReleases = async (variant: number): Promise<IMovementBody[]> => {
    const { body } = await server()
      .get(`/api/inventory/variants/${variant}/movements`)
      .query({ type: 'release' })
      .set('Authorization', adminAuth);
    return (body as IPageBody<IMovementBody>).items;
  };

  const getOrder = async (orderId: number): Promise<IOrderBody> => {
    const { body } = await server().get(`/api/orders/${orderId}`).set('Authorization', adminAuth);
    return body as IOrderBody;
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

    variantId = await provisionVariant('a', RECEIVED_QTY);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('places, fully fulfills, and ships a one-line order', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    cartId = (create.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: ORDERED_QTY });
    expect(add.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `cancel-ship-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    order = place.body as IOrderBody;

    const createFul = await server()
      .post(`/api/orders/${order.id}/fulfillments`)
      .set('Authorization', adminAuth)
      .send({ lines: [{ orderLineId: order.lines[0].id, quantity: ORDERED_QTY }] });
    expect(createFul.status).toBe(HttpStatus.CREATED);
    fulfillmentId = (createFul.body as IFulfillmentBody).id;

    const ship = await server()
      .post(`/api/orders/${order.id}/fulfillments/${fulfillmentId}/ship`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `cancel-ship-${stamp}-ship`)
      .send({ trackingNumber: '1Z999AA10123456789', carrier: 'UPS' });
    expect(ship.status).toBe(HttpStatus.OK);
    expect((ship.body as IFulfillmentBody).status).toBe('shipped');

    const fresh = await getOrder(order.id);
    expect(fresh.fulfillmentStatus).toBe('shipped');
    expect(fresh.paymentStatus).toBe('captured');
  });

  it('a staff cancel of the shipped order is rejected 409 ORDER_NOT_CANCELLABLE', async () => {
    const cancel = await server()
      .post(`/api/orders/${order.id}/cancel`)
      .set('Authorization', adminAuth)
      .send({ reason: 'Attempting to cancel a shipped order' });

    expect(cancel.status).toBe(HttpStatus.CONFLICT);
    expect((cancel.body as { code: string }).code).toBe('ORDER_NOT_CANCELLABLE');
  });

  it('the owning customer is likewise rejected 409 (state guard, not authorization)', async () => {
    const cancel = await server()
      .post(`/api/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ reason: 'owner attempt' });

    expect(cancel.status).toBe(HttpStatus.CONFLICT);
    expect((cancel.body as { code: string }).code).toBe('ORDER_NOT_CANCELLABLE');
  });

  it('the rejected cancel changed nothing: order still shipped/captured, stock untouched, no release', async () => {
    const fresh = await getOrder(order.id);
    expect(fresh.status).toBe('pending');
    expect(fresh.fulfillmentStatus).toBe('shipped');
    expect(fresh.paymentStatus).toBe('captured');
    expect(fresh.lines[0].status).toBe('shipped');

    // The shipped sale decremented on-hand + allocated; the blocked cancel released
    // nothing, so the counters stand and the ledger holds no `release` row.
    const level = await warehouseLevel(variantId);
    expect(level.quantityOnHand).toBe(RECEIVED_QTY - ORDERED_QTY);
    expect(level.quantityAllocated).toBe(0);
    expect(await listReleases(variantId)).toHaveLength(0);
  });
});
