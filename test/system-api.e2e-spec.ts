import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';
import { ObjectLiteral } from 'typeorm';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import {
  CacheHelper,
  CORRELATION_ID_HEADER,
  MicroserviceQueueEnum,
} from '@retail-inventory-system/common';
import { ProductStockGetResponseDto } from '@retail-inventory-system/inventory';
import { SystemApiE2ESpecDataSource } from './data-source';

describe('Retail Inventory System API', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: SystemApiE2ESpecDataSource;
  let cache: Cache;

  const getCachedStock = (productId: number, storageIds?: string[]) =>
    cache.get<ProductStockGetResponseDto>(CacheHelper.keys.productStock(productId, storageIds));
  const setCachedStock = (
    productId: number,
    storageIds: string[] | undefined,
    value: ProductStockGetResponseDto,
  ) => cache.set(CacheHelper.keys.productStock(productId, storageIds), value);

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

    // Cache provider is global; pulled from the inventory microservice's DI graph
    // so cache assertions go through the same abstraction the service uses.
    cache = inventoryMicroservice.get<Cache>(CACHE_MANAGER, { strict: false });
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    // Isolate cache state across tests — without this, a previous test's writes
    // would mask cache miss/hit branches in subsequent tests.
    await cache.clear();
  });

  describe('Product', () => {
    describe('GET /api/product/:productId/stock', () => {
      const apiHref = (productId: number | string) => `/api/product/${productId}/stock`;

      // Non-mutating: builds a stripped clone for snapshot comparison instead of
      // deleting fields on the live response body.
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

        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer()).get(
          apiHref(1),
        );

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        assertSnapshot(body);
        // G1: cache miss → DB → cache write of the unfiltered key.
        await expect(getCachedStock(1)).resolves.toMatchObject({ productId: 1, quantity: 5 });
      });

      it('returns stock filtered by matching storageIds', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
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
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
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
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer()).get(
          apiHref(0),
        );

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
        // Sentinel pattern: prime the cache with a value the DB cannot produce
        // (quantity 999). If a follow-up GET returns this value, the response
        // must have come from cache — no DB read happened.
        const sentinel: ProductStockGetResponseDto = {
          productId: 1,
          quantity: 999,
          updatedAt: null,
          items: [],
        };
        await setCachedStock(1, undefined, sentinel);

        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer()).get(
          apiHref(1),
        );

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        // G2: response equals the sentinel → cache hit, no DB read.
        expect(body).toEqual(sentinel);
      });

      it('returns 400 when storageIds is not valid JSON', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .get(apiHref(1))
          .query({ storageIds: 'not-valid-json' });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when productId is not a number', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer()).get(
          apiHref('abc'),
        );

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
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
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .post(apiHref)
          .send({ customerId: 1, products: [{ productId: 1, quantity: 1 }] });

        const { orderRows, orderProductRows } = await getDataToBeAsserted(body.orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.CREATED);
        assertData({ body, orderRows, orderProductRows });
      });

      it('creates an order expanding each product quantity into individual order_product rows', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .post(apiHref)
          .send({
            customerId: 1,
            products: [
              { productId: 1, quantity: 2 },
              { productId: 2, quantity: 1 },
            ],
          });

        const { orderRows, orderProductRows } = await getDataToBeAsserted(body.orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.CREATED);
        assertData({ body, orderRows, orderProductRows });
      });

      it('returns 404 when customerId does not exist', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .post(apiHref)
          .send({ customerId: 9999, products: [{ productId: 1, quantity: 1 }] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.NOT_FOUND);
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when productId does not exist', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .post(apiHref)
          .send({ customerId: 1, products: [{ productId: 9999, quantity: 1 }] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when products array is empty', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .post(apiHref)
          .send({ customerId: 1, products: [] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when customerId is missing', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .post(apiHref)
          .send({ products: [{ productId: 1, quantity: 1 }] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when customerId is not a positive integer', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .post(apiHref)
          .send({ customerId: 0, products: [{ productId: 1, quantity: 1 }] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when products is missing', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .post(apiHref)
          .send({ customerId: 1 });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when products[].productId is not a positive integer', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .post(apiHref)
          .send({ customerId: 1, products: [{ productId: 0, quantity: 1 }] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when products[].quantity is not a positive integer', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .post(apiHref)
          .send({ customerId: 1, products: [{ productId: 1, quantity: 0 }] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when the request body contains an unknown field', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer())
          .post(apiHref)
          .send({ customerId: 1, products: [{ productId: 1, quantity: 1 }], unknownField: 'x' });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
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

      // Placeholder DTO used to prime the cache before a confirm — exact field
      // values don't matter; only presence/absence after confirm does.
      const cachedSentinel = (productId: number): ProductStockGetResponseDto => ({
        productId,
        quantity: 42,
        updatedAt: null,
        items: [],
      });

      it('confirms all products and the order when every product has sufficient stock', async () => {
        const orderId = 1;
        // C1 + C5: prime two distinct keys per affected productId to prove the
        // SCAN scope catches BOTH the unfiltered (`stock:1:*`) key and the
        // per-storage (`stock:1:head-warehouse`) key.
        await Promise.all([
          setCachedStock(1, undefined, cachedSentinel(1)),
          setCachedStock(1, ['head-warehouse'], cachedSentinel(1)),
          setCachedStock(2, undefined, cachedSentinel(2)),
        ]);

        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer()).put(
          apiHref(orderId),
        );
        const { orderRows, orderProductRows, productStockRows } =
          await getDataToBeAsserted(orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
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

        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer()).put(
          apiHref(orderId),
        );
        const { orderRows, orderProductRows, productStockRows } =
          await getDataToBeAsserted(orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        assertData({ body, orderRows, orderProductRows, productStockRows });
        // Mutated product cache cleared; untouched product cache survives.
        expect(await getCachedStock(3)).toBeUndefined();
        await expect(getCachedStock(1)).resolves.toMatchObject({ productId: 1, quantity: 42 });
      });

      it('leaves everything pending when there is no stock for any product', async () => {
        const orderId = 3;
        // C2: prime cache for the order's productId (4 — out of stock). Since
        // no ledger rows are inserted, the invalidate path is never called and
        // the cache must survive.
        await setCachedStock(4, undefined, cachedSentinel(4));

        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer()).put(
          apiHref(orderId),
        );
        const { orderRows, orderProductRows, productStockRows } =
          await getDataToBeAsserted(orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.OK);
        assertData({ body, orderRows, orderProductRows, productStockRows });
        await expect(getCachedStock(4)).resolves.toMatchObject({ productId: 4, quantity: 42 });
      });

      it('returns 400 when the order is already confirmed', async () => {
        const orderId = 4;

        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer()).put(
          apiHref(orderId),
        );
        const { orderRows, orderProductRows, productStockRows } =
          await getDataToBeAsserted(orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        assertData({ body, orderRows, orderProductRows, productStockRows });
      });

      it('returns 404 when the order does not exist', async () => {
        const orderId = 0;

        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer()).put(
          apiHref(orderId),
        );
        const { orderRows, orderProductRows, productStockRows } =
          await getDataToBeAsserted(orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.NOT_FOUND);
        assertData({ body, orderRows, orderProductRows, productStockRows });
      });

      it('returns 400 when orderId is not a number', async () => {
        const { status, body, headers } = await supertest(apiGatewayApp.getHttpServer()).put(
          apiHref('abc' as unknown as number),
        );

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body).toMatchSnapshot();
      });
    });
  });
});
