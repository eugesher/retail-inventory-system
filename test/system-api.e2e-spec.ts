import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';
import { ObjectLiteral } from 'typeorm';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { CACHE_KEYS } from '@retail-inventory-system/cache';
import {
  MicroserviceQueueEnum,
  OrderProductStatusEnum,
  OrderStatusEnum,
  ProductStockGetResponseDto,
} from '@retail-inventory-system/contracts';
import { CORRELATION_ID_HEADER } from '@retail-inventory-system/observability';
import { SystemApiE2ESpecDataSource } from './data-source';

describe('Retail Inventory System API', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: SystemApiE2ESpecDataSource;
  let cache: Cache;
  let staffAccessToken: string;
  // Memory-backed Pino capture (TEST-002) — install lives in `jest.setup.ts`;
  // records from all three apps share one array, distinguishable by `app`.
  const capturedLogs = (globalThis as { __RIS_E2E_CAPTURED_LOGS__?: Record<string, unknown>[] })
    .__RIS_E2E_CAPTURED_LOGS__!;

  // `admin@example.com` is established by `yarn test:seed`; one login,
  // reused across every assertion below as a bearer-token source. Customer-side
  // flows (register/login) live in `test/auth-customer.e2e-spec.ts`; the order
  // endpoints here carry no customer association — future checkout work re-links
  // orders to the gateway customer aggregate.
  const httpClient = () => {
    const agent = supertest.agent(apiGatewayApp.getHttpServer());
    agent.set('Authorization', `Bearer ${staffAccessToken}`);
    return agent;
  };

  const getCachedStock = (productId: number, storageIds?: string[]) =>
    cache.get<ProductStockGetResponseDto>(CACHE_KEYS.inventoryStock(productId, storageIds));
  const setCachedStock = (
    productId: number,
    storageIds: string[] | undefined,
    value: ProductStockGetResponseDto,
  ) => cache.set(CACHE_KEYS.inventoryStock(productId, storageIds), value);

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

    await Promise.all([retailMicroservice.listen(), inventoryMicroservice.listen()]);

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );

    await apiGatewayApp.init();

    dataSource = new SystemApiE2ESpecDataSource({ type: 'mysql', url: process.env.DATABASE_URL! });

    await dataSource.initialize();

    // Pulled from the inventory microservice's DI graph so assertions go
    // through the same cache abstraction the service uses.
    cache = inventoryMicroservice.get<Cache>(CACHE_MANAGER, { strict: false });

    const loginResponse = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'admin1234' });
    staffAccessToken = loginResponse.body.accessToken;
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    // Per-test isolation — without it, a prior write masks the miss/hit branches below.
    await cache.clear();
    // Per-test isolation for log-based side-channel assertions.
    capturedLogs.length = 0;
  });

  describe('Product', () => {
    describe('GET /api/product/:productId/stock', () => {
      const apiHref = (productId: number | string) => `/api/product/${productId}/stock`;

      // Non-mutating clone — mutating `body` in-place would corrupt later assertions on `body.updatedAt`.
      const assertSnapshot = (body: any) => {
        const stripped = { ...(body as ObjectLiteral) };

        delete stripped.updatedAt;
        stripped.items = stripped.items.map((item: any) => {
          expect(item.updatedAt).toBeDefined();
          const rest = { ...item };
          delete rest.updatedAt;
          return rest;
        });

        expect(stripped).toMatchSnapshot();
      };

      it('returns aggregated stock for all storages when storageIds is omitted', async () => {
        expect(await getCachedStock(1)).toBeUndefined();

        const { status, body, headers } = await httpClient().get(apiHref(1));

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        assertSnapshot(body);
        // G1: cache miss → DB → cache write of the unfiltered key.
        await expect(getCachedStock(1)).resolves.toMatchObject({ productId: 1, quantity: 5 });
      });

      it('returns stock filtered by matching storageIds', async () => {
        const { status, body, headers } = await httpClient()
          .get(apiHref(1))
          .query({ storageIds: '["head-warehouse"]' });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        assertSnapshot(body);
        // G3: per-storage key populated; unfiltered key is not.
        await expect(getCachedStock(1, ['head-warehouse'])).resolves.toMatchObject({
          productId: 1,
        });
        expect(await getCachedStock(1)).toBeUndefined();
      });

      it('returns empty items and zero quantity when storageIds filter matches no storage', async () => {
        const { status, body, headers } = await httpClient()
          .get(apiHref(1))
          .query({ storageIds: '["non-existent-storage"]' });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        assertSnapshot(body);
        // G5: empty result is cached too — proves negative-result caching.
        await expect(getCachedStock(1, ['non-existent-storage'])).resolves.toEqual({
          productId: 1,
          quantity: 0,
          updatedAt: null,
          items: [],
        });
      });

      it('returns empty items and zero quantity when product has no stock', async () => {
        const { status, body, headers } = await httpClient().get(apiHref(0));

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        assertSnapshot(body);
        // G4: empty-product result cached at the unfiltered key for productId=0.
        await expect(getCachedStock(0)).resolves.toEqual({
          productId: 0,
          quantity: 0,
          updatedAt: null,
          items: [],
        });
      });

      it('serves cached value on subsequent calls without re-querying the DB', async () => {
        // Sentinel pattern: quantity 999 is impossible from the DB, so receiving
        // it back on the follow-up GET proves the response came from cache.
        const sentinel: ProductStockGetResponseDto = {
          productId: 1,
          quantity: 999,
          updatedAt: null,
          items: [],
        };
        await setCachedStock(1, undefined, sentinel);

        const { status, body, headers } = await httpClient().get(apiHref(1));

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        // G2: response equals the sentinel → cache hit, no DB read.
        expect(body).toEqual(sentinel);
        // TEST-002: log-based side-channel — proves the *capability* of asserting
        // on Pino logs end-to-end, complementing the sentinel above which proves
        // the cache-hit branch. `StockCache.get` emits a debug with `cacheHit: true`.
        expect(capturedLogs).toContainEqual(
          expect.objectContaining({
            cacheHit: true,
            // `LoggerModuleConfig` prepends `[<app>] ` via `msgPrefix`, so use `stringContaining`.
            msg: expect.stringContaining('Cache hit for stock query'),
            productId: 1,
          }),
        );
      });

      it('returns 400 when storageIds is not valid JSON', async () => {
        const { status, body, headers } = await httpClient()
          .get(apiHref(1))
          .query({ storageIds: 'not-valid-json' });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        // TEST-001: explicit body assertion paired with the snapshot — attributes
        // 4xx body-schema drift vs. unrelated wording changes when the snapshot fires.
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when productId is not a number', async () => {
        const { status, body, headers } = await httpClient().get(apiHref('abc'));

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });
    });
  });

  describe('Order', () => {
    describe('POST /api/order', () => {
      const apiHref = '/api/order';

      const getDataToBeAsserted = async (orderId: number) => {
        const [orderRows, orderProductRows] = await Promise.all([
          dataSource.getOrderRowsByOrderId(orderId),
          dataSource.getOrderProductRowsByOrderId(orderId),
        ]);

        return { orderRows, orderProductRows };
      };

      const assertData = (data: { body: any; orderRows: any[]; orderProductRows: any[] }) => {
        const { body, orderRows, orderProductRows } = data;

        expect(body).toMatchSnapshot('0_RESPONSE_BODY');
        expect(orderRows).toMatchSnapshot('1_ORDERS');
        expect(orderProductRows).toMatchSnapshot('2_ORDER_PRODUCTS');
      };

      it('creates an order with a single product', async () => {
        const { status, body, headers } = await httpClient()
          .post(apiHref)
          .send({ products: [{ productId: 1, quantity: 1 }] });

        const { orderRows, orderProductRows } = await getDataToBeAsserted(body.orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.CREATED);
        // TEST-001: explicit field assertions to attribute regressions —
        // status string, header row count, line-item expansion count.
        expect(body.orderId).toEqual(expect.any(Number));
        expect(body.status).toBe(OrderStatusEnum.PENDING);
        expect(orderRows).toHaveLength(1);
        expect(orderRows[0].status_id).toBe(OrderStatusEnum.PENDING);
        expect(orderProductRows).toHaveLength(1);
        expect(
          orderProductRows.every((r: any) => r.status_id === OrderProductStatusEnum.PENDING),
        ).toBe(true);
        assertData({ body, orderRows, orderProductRows });
      });

      it('creates an order expanding each product quantity into individual order_product rows', async () => {
        const { status, body, headers } = await httpClient()
          .post(apiHref)
          .send({
            products: [
              { productId: 1, quantity: 2 },
              { productId: 2, quantity: 1 },
            ],
          });

        const { orderRows, orderProductRows } = await getDataToBeAsserted(body.orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.CREATED);
        expect(body.status).toBe(OrderStatusEnum.PENDING);
        expect(orderRows).toHaveLength(1);
        expect(orderProductRows).toHaveLength(3);
        expect(
          orderProductRows.every((r: any) => r.status_id === OrderProductStatusEnum.PENDING),
        ).toBe(true);
        assertData({ body, orderRows, orderProductRows });
      });

      it('returns 400 when productId does not exist', async () => {
        const { status, body, headers } = await httpClient()
          .post(apiHref)
          .send({ products: [{ productId: 9999, quantity: 1 }] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when products array is empty', async () => {
        const { status, body, headers } = await httpClient().post(apiHref).send({ products: [] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when products is missing', async () => {
        const { status, body, headers } = await httpClient().post(apiHref).send({});

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when products[].productId is not a positive integer', async () => {
        const { status, body, headers } = await httpClient()
          .post(apiHref)
          .send({ products: [{ productId: 0, quantity: 1 }] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when products[].quantity is not a positive integer', async () => {
        const { status, body, headers } = await httpClient()
          .post(apiHref)
          .send({ products: [{ productId: 1, quantity: 0 }] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when the request body contains an unknown field', async () => {
        const { status, body, headers } = await httpClient()
          .post(apiHref)
          .send({ products: [{ productId: 1, quantity: 1 }], unknownField: 'x' });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });
    });

    describe('PUT /api/order/:id/confirm', () => {
      const apiHref = (orderId: number) => `/api/order/${orderId}/confirm`;

      const getDataToBeAsserted = async (
        orderId: number,
      ): Promise<{
        orderRows: any[];
        orderProductRows: any[];
        productStockRows: any[];
      }> => {
        const [orderRows, orderProductRows, productStockRows] = await Promise.all([
          dataSource.getOrderRowsByOrderId(orderId),
          dataSource.getOrderProductRowsByOrderId(orderId),
          dataSource.getProductStockRowsByOrderId(orderId),
        ]);

        return { orderRows, orderProductRows, productStockRows };
      };

      const assertData = (data: {
        body: any;
        orderRows: any[];
        orderProductRows: any[];
        productStockRows: any[];
      }) => {
        const { body, orderRows, orderProductRows, productStockRows } = data;

        expect(body).toMatchSnapshot('0_RESPONSE_BODY');
        expect(orderRows).toMatchSnapshot('1_ORDERS');
        expect(orderProductRows).toMatchSnapshot('2_ORDER_PRODUCTS');
        expect(productStockRows).toMatchSnapshot('3_PRODUCT_STOCK');
      };

      // Primes the cache before a confirm — only presence/absence after the confirm matters.
      const cachedSentinel = (productId: number): ProductStockGetResponseDto => ({
        productId,
        quantity: 42,
        updatedAt: null,
        items: [],
      });

      it('confirms all products and the order when every product has sufficient stock', async () => {
        const orderId = 1;
        // C1 + C5: prime BOTH the unfiltered key and the per-storage key for the
        // affected productId to prove the SCAN scope catches both.
        await Promise.all([
          setCachedStock(1, undefined, cachedSentinel(1)),
          setCachedStock(1, ['head-warehouse'], cachedSentinel(1)),
          setCachedStock(2, undefined, cachedSentinel(2)),
        ]);

        const { status, body, headers } = await httpClient().put(apiHref(orderId));
        const { orderRows, orderProductRows, productStockRows } =
          await getDataToBeAsserted(orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        // TEST-001 contract for the all-confirmed branch: header CONFIRMED,
        // every line CONFIRMED, one ledger row per line with quantity -1.
        expect(body.status.id).toBe(OrderStatusEnum.CONFIRMED);
        expect(orderRows).toHaveLength(1);
        expect(orderRows[0].status_id).toBe(OrderStatusEnum.CONFIRMED);
        expect(
          orderProductRows.every((r: any) => r.status_id === OrderProductStatusEnum.CONFIRMED),
        ).toBe(true);
        expect(productStockRows.length).toBeGreaterThan(0);
        expect(productStockRows.every((r: any) => r.quantity === -1)).toBe(true);
        assertData({ body, orderRows, orderProductRows, productStockRows });
        // Post-commit SCAN+UNLINK invalidated every key for the mutated products.
        expect(await getCachedStock(1)).toBeUndefined();
        expect(await getCachedStock(1, ['head-warehouse'])).toBeUndefined();
        expect(await getCachedStock(2)).toBeUndefined();
      });

      it('confirms only products with available stock and leaves the order pending', async () => {
        const orderId = 2;
        // C3: prime caches for a mutated product (3) AND an unrelated product
        // (1, not in this order). Only product 3's cache must be invalidated.
        await Promise.all([
          setCachedStock(3, undefined, cachedSentinel(3)),
          setCachedStock(1, undefined, cachedSentinel(1)),
        ]);

        const { status, body, headers } = await httpClient().put(apiHref(orderId));
        const { orderRows, orderProductRows, productStockRows } =
          await getDataToBeAsserted(orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        // Partial branch: header stays PENDING; ledger has fewer rows than
        // the order has lines; the rows present must still be quantity -1.
        expect(body.status.id).toBe(OrderStatusEnum.PENDING);
        expect(orderRows[0].status_id).toBe(OrderStatusEnum.PENDING);
        expect(productStockRows.length).toBeGreaterThan(0);
        expect(productStockRows.length).toBeLessThan(orderProductRows.length);
        expect(productStockRows.every((r: any) => r.quantity === -1)).toBe(true);
        assertData({ body, orderRows, orderProductRows, productStockRows });
        // Mutated product cache cleared; untouched product cache survives.
        expect(await getCachedStock(3)).toBeUndefined();
        await expect(getCachedStock(1)).resolves.toMatchObject({ productId: 1, quantity: 42 });
      });

      it('leaves everything pending when there is no stock for any product', async () => {
        const orderId = 3;
        // C2: prime cache for the order's out-of-stock productId. With no ledger
        // rows inserted, the invalidate path is never called and the cache survives.
        await setCachedStock(4, undefined, cachedSentinel(4));

        const { status, body, headers } = await httpClient().put(apiHref(orderId));
        const { orderRows, orderProductRows, productStockRows } =
          await getDataToBeAsserted(orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        // Out-of-stock branch: header PENDING, every line PENDING, no
        // ledger rows written at all (so the invalidate path was skipped).
        expect(body.status.id).toBe(OrderStatusEnum.PENDING);
        expect(orderRows[0].status_id).toBe(OrderStatusEnum.PENDING);
        expect(
          orderProductRows.every((r: any) => r.status_id === OrderProductStatusEnum.PENDING),
        ).toBe(true);
        expect(productStockRows).toHaveLength(0);
        assertData({ body, orderRows, orderProductRows, productStockRows });
        await expect(getCachedStock(4)).resolves.toMatchObject({ productId: 4, quantity: 42 });
      });

      it('returns 400 when the order is already confirmed', async () => {
        const orderId = 4;

        const { status, body, headers } = await httpClient().put(apiHref(orderId));
        const { orderRows, orderProductRows, productStockRows } =
          await getDataToBeAsserted(orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        // Already-confirmed guard: status 400, message names the transition,
        // no ledger rows inserted.
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body.message).toContain('cannot be confirmed');
        expect(productStockRows).toHaveLength(0);
        assertData({ body, orderRows, orderProductRows, productStockRows });
      });

      it('returns 404 when the order does not exist', async () => {
        const orderId = 0;

        const { status, body, headers } = await httpClient().put(apiHref(orderId));
        const { orderRows, orderProductRows, productStockRows } =
          await getDataToBeAsserted(orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.NOT_FOUND);
        // Not-found guard: status 404, message names the missing id,
        // nothing in any of the joined tables.
        expect(body.statusCode).toBe(HttpStatus.NOT_FOUND);
        expect(body.error).toBe('Not Found');
        expect(body.message).toContain('not found');
        expect(orderRows).toHaveLength(0);
        expect(orderProductRows).toHaveLength(0);
        expect(productStockRows).toHaveLength(0);
        assertData({ body, orderRows, orderProductRows, productStockRows });
      });

      it('returns 400 when orderId is not a number', async () => {
        const { status, body, headers } = await httpClient().put(
          apiHref('abc' as unknown as number),
        );

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });
    });
  });
});
