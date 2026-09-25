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

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_PASSWORD = 'customer1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';

const NUM_RACERS = 10;
const SUPPLY = 5;

const ADDRESS = {
  recipientName: 'Race Buyer',
  line1: '1 Market St',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94105',
  country: 'US',
};

const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ECONNABORTED']);

interface ITokenResponse {
  accessToken: string;
}

interface ICartBody {
  id: string;
}

interface IStockLevelBody {
  stockLocationId: string;
  quantityOnHand: number;
  quantityAllocated: number;
  quantityReserved: number;
  available: number;
}

interface IVariantStockBody {
  locations: IStockLevelBody[];
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

interface IHttpResult {
  status: number;
  body: Record<string, unknown>;
}

interface IRacer {
  token: string;
  cartId: string;
}

interface ICheckoutOutcome {
  outcome: 'placed' | 'out-of-stock';
  orderId?: number;
}

describe('Concurrent place order: 10 racers, 5 supply → exactly 5 succeed (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let variantId: number;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const customerLogin = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/customer/login').send({ email, password });
    return (body as ITokenResponse).accessToken;
  };

  const registerCustomer = async (index: number): Promise<string> => {
    const email = `conc-place-${stamp}-${index}@example.com`;
    await server().post('/api/auth/customer/register').send({ email, password: CUSTOMER_PASSWORD });
    return customerLogin(email, CUSTOMER_PASSWORD);
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

  const sendWithNetRetry = async (
    build: () => supertest.Test,
    maxTries = 8,
  ): Promise<IHttpResult> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxTries; attempt++) {
      try {
        const res = await build();
        return { status: res.status, body: res.body as Record<string, unknown> };
      } catch (error) {
        lastError = error;
        const code = (error as { code?: string }).code;
        if (code && TRANSIENT_NET_CODES.has(code)) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Exhausted network retries: ${String(lastError)}`);
  };

  const provisionVariant = async (label: string, onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Conc Place ${label} ${stamp}`,
        slug: `e2e-conc-place-${label}-${stamp}`,
        description: 'concurrent-place fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-CONCPL-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

  const openCart = async (token: string): Promise<string> => {
    const { body } = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ currency: 'USD' });
    return (body as ICartBody).id;
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

  const listMovements = async (variant: number): Promise<IMovementBody[]> => {
    const { body } = await server()
      .get(`/api/inventory/variants/${variant}/movements`)
      .set('Authorization', adminAuth);
    return (body as IPageBody<IMovementBody>).items;
  };

  const sendRetryingConflicts = async (
    build: () => supertest.Test,
    maxTries = 50,
  ): Promise<IHttpResult> => {
    let last: IHttpResult = { status: 0, body: {} };
    for (let attempt = 0; attempt < maxTries; attempt++) {
      last = await sendWithNetRetry(build);
      if (
        last.status === (HttpStatus.CONFLICT as number) &&
        last.body.code === 'INVENTORY_STOCK_WRITE_CONFLICT'
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      return last;
    }
    return last;
  };

  const checkout = async (racer: IRacer, index: number): Promise<ICheckoutOutcome> => {
    const add = await sendRetryingConflicts(() =>
      server()
        .post(`/api/cart/${racer.cartId}/lines`)
        .set('Authorization', `Bearer ${racer.token}`)
        .send({ variantId, quantity: 1 }),
    );

    if (add.status === (HttpStatus.CONFLICT as number)) {
      expect(['INVENTORY_OUT_OF_STOCK', 'INVENTORY_STOCK_WRITE_CONFLICT']).toContain(add.body.code);
      return { outcome: 'out-of-stock' };
    }
    expect(add.status).toBe(HttpStatus.OK);

    const place = await sendRetryingConflicts(() =>
      server()
        .post(`/api/cart/${racer.cartId}/place`)
        .set('Authorization', `Bearer ${racer.token}`)
        .set('Idempotency-Key', `conc-place-${stamp}-${index}`)
        .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' }),
    );
    expect(place.status).toBe(HttpStatus.CREATED);
    return { outcome: 'placed', orderId: (place.body as { id: number }).id };
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
    variantId = await provisionVariant('a', SUPPLY);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it(
    `exactly ${SUPPLY} of ${NUM_RACERS} checkouts succeed; the rest get OUT_OF_STOCK; no duplicate allocations`,
    async () => {
      const racers: IRacer[] = [];
      for (let index = 0; index < NUM_RACERS; index++) {
        const token = await registerCustomer(index);
        racers.push({ token, cartId: await openCart(token) });
      }

      const outcomes = await Promise.all(racers.map((racer, index) => checkout(racer, index)));

      const placed = outcomes.filter((o) => o.outcome === 'placed');
      const outOfStock = outcomes.filter((o) => o.outcome === 'out-of-stock');
      expect(placed).toHaveLength(SUPPLY);
      expect(outOfStock).toHaveLength(NUM_RACERS - SUPPLY);

      const level = await warehouseLevel(variantId);
      expect(level.quantityOnHand).toBe(SUPPLY);
      expect(level.quantityAllocated).toBe(SUPPLY);
      expect(level.quantityReserved).toBe(0);
      expect(level.available).toBe(0);
      expect(level.quantityAllocated).toBeGreaterThanOrEqual(0);
      expect(level.available).toBeGreaterThanOrEqual(0);

      const allocations = (await listMovements(variantId)).filter((m) => m.type === 'allocation');
      expect(allocations).toHaveLength(SUPPLY);
      expect(allocations.every((m) => m.quantity === -1)).toBe(true);

      const placedOrderIds = new Set(placed.map((o) => String(o.orderId)));
      const allocationOrderIds = allocations.map((m) => m.referenceId);
      expect(new Set(allocationOrderIds).size).toBe(SUPPLY);
      expect(allocationOrderIds.every((id) => id !== null && placedOrderIds.has(id))).toBe(true);
    },
    timeout,
  );
});
