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

// Place Order allocates the cart's holds end-to-end (ADR-030). Inside the place
// transaction, after the cart-conversion CAS, each line's active reservation is
// committed and its counter moves reserved → allocated — on-hand never changes (an
// allocation is a within-warehouse reclassification, not a shipment). Each line
// leaves exactly one negative `allocation` `StockMovement` referencing the order,
// and a repeat-place on the already-converted cart returns the same order WITHOUT
// appending any further movement (allocation is one-shot, cart-state-driven).
//
// Two variants (one order line each) make the "one allocation row per order line"
// invariant observable per-variant; the audit read is per-variant, so a two-line
// cart is asserted as two single-row ledgers, not one summed figure.
//
// Self-provisioned, disjoint fixtures (`e2e-place-alloc-*`): each variant gets its
// own product, price, and `receive`d stock — the shared seeded variants are never
// touched.
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
  orderNumber: string;
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
  total: number;
  page: number;
  size: number;
}

describe('Place Order allocates the cart holds (e2e)', () => {
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
  let placed: IOrderBody;

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

  const waitForStockRow = async (variantId: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRows(variantId)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variantId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const provisionVariant = async (label: string, onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Place Alloc ${label} ${stamp}`,
        slug: `e2e-place-alloc-${label}-${stamp}`,
        description: 'place/allocate fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-PLALLOC-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variantId = (variantRes.body as { id: number }).id;

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
      .send({ quantity: onHand });
    expect(receiveRes.status).toBe(HttpStatus.OK);

    return variantId;
  };

  const warehouseLevel = async (variantId: number): Promise<IStockLevelBody> => {
    const { body } = await server().get(`/api/inventory/variants/${variantId}/stock`);
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

  const listAllocations = async (variantId: number): Promise<IMovementBody[]> => {
    const { body } = await server()
      .get(`/api/inventory/variants/${variantId}/movements`)
      .query({ type: 'allocation' })
      .set('Authorization', adminAuth);
    return (body as IPageBody<IMovementBody>).items;
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

    variantA = await provisionVariant('a', 10);
    variantB = await provisionVariant('b', 10);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('builds a two-line cart: A qty 2, B qty 3 — holds drop available (reserve)', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    cartId = (create.body as ICartBody).id;

    const addA = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId: variantA, quantity: 2 });
    expect(addA.status).toBe(HttpStatus.OK);

    const addB = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId: variantB, quantity: 3 });
    expect(addB.status).toBe(HttpStatus.OK);

    const levelA = await warehouseLevel(variantA);
    expect(levelA.quantityOnHand).toBe(10);
    expect(levelA.quantityReserved).toBe(2);
    expect(levelA.available).toBe(8);

    const levelB = await warehouseLevel(variantB);
    expect(levelB.quantityReserved).toBe(3);
    expect(levelB.available).toBe(7);
  });

  it('places the cart → 201 OrderView; reserved becomes allocated, on-hand unchanged', async () => {
    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `place-alloc-${stamp}-1`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });

    expect(place.status).toBe(HttpStatus.CREATED);
    placed = place.body as IOrderBody;
    expect(placed.status).toBe('pending');

    const levelA = await warehouseLevel(variantA);
    expect(levelA.quantityOnHand).toBe(10);
    expect(levelA.quantityAllocated).toBe(2);
    expect(levelA.quantityReserved).toBe(0);
    expect(levelA.available).toBe(8);

    const levelB = await warehouseLevel(variantB);
    expect(levelB.quantityOnHand).toBe(10);
    expect(levelB.quantityAllocated).toBe(3);
    expect(levelB.quantityReserved).toBe(0);
    expect(levelB.available).toBe(7);
  });

  it('writes exactly one negative `allocation` movement per order line, referencing the order', async () => {
    const allocationsA = await listAllocations(variantA);
    expect(allocationsA).toHaveLength(1);
    expect(allocationsA[0].type).toBe('allocation');
    expect(allocationsA[0].quantity).toBe(-2);
    expect(allocationsA[0].referenceType).toBe('order');
    expect(allocationsA[0].referenceId).toBe(String(placed.id));

    const allocationsB = await listAllocations(variantB);
    expect(allocationsB).toHaveLength(1);
    expect(allocationsB[0].quantity).toBe(-3);
    expect(allocationsB[0].referenceType).toBe('order');
    expect(allocationsB[0].referenceId).toBe(String(placed.id));
  });

  it('repeat-place on the converted cart returns the same order and appends NO new movement', async () => {
    const repeat = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `place-alloc-${stamp}-2`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });

    expect(repeat.status).toBe(HttpStatus.CREATED);
    const repeatOrder = repeat.body as IOrderBody;
    expect(repeatOrder.id).toBe(placed.id);
    expect(repeatOrder.orderNumber).toBe(placed.orderNumber);

    // Allocation is one-shot: the ledger still shows exactly one row per variant.
    expect(await listAllocations(variantA)).toHaveLength(1);
    expect(await listAllocations(variantB)).toHaveLength(1);

    // And the counters did not move again.
    const levelA = await warehouseLevel(variantA);
    expect(levelA.quantityAllocated).toBe(2);
    expect(levelA.quantityReserved).toBe(0);
  });
});
