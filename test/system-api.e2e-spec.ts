import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Connection, createConnection } from 'mysql2/promise';
import * as supertest from 'supertest';
import { ObjectLiteral } from 'typeorm';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/common';

describe('Retail Inventory System API', () => {
  type SelectQueryResult = [any[], any[]];

  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let db: Connection;

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

    db = await createConnection(process.env.DATABASE_URL!);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await inventoryMicroservice?.close();
    await db?.end();
  });

  describe('GET /api/product/:productId/stock', () => {
    const apiHref = (productId: number | string) => `/api/product/${productId}/stock`;
    const assertData = (body: any) => {
      body = body as ObjectLiteral;

      expect(body.updatedAt).toBeDefined();

      delete body.updatedAt;

      for (const item of body.items) {
        delete item.updatedAt;
      }

      expect(body).toMatchSnapshot();
    };

    it('returns aggregated stock for all storages when storageIds is omitted', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(apiHref(1));

      expect(status).toBe(HttpStatus.OK);
      assertData(body);
    });

    it('returns stock filtered by matching storageIds', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get(apiHref(1))
        .query({ storageIds: '["head-warehouse"]' });

      expect(status).toBe(HttpStatus.OK);
      assertData(body);
    });

    it('returns empty items and zero quantity when storageIds filter matches no storage', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get(apiHref(1))
        .query({ storageIds: '["non-existent-storage"]' });

      expect(status).toBe(HttpStatus.OK);
      assertData(body);
    });

    it('returns empty items and zero quantity when product has no stock', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(apiHref(0));

      expect(status).toBe(HttpStatus.OK);
      assertData(body);
    });

    it('returns 400 when storageIds is not valid JSON', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get(apiHref(1))
        .query({ storageIds: 'not-valid-json' });

      expect(status).toBe(HttpStatus.BAD_REQUEST);
      expect(body).toMatchSnapshot();
    });

    it('returns 400 when productId is not a number', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(apiHref('abc'));

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
      const orderQuery = `
        SELECT status_id
        FROM \`order\`
        WHERE id = ?;
      `;
      const orderProductQuery = `
        SELECT id, status_id
        FROM order_product
        WHERE order_id = ?
        ORDER BY id;
      `;
      const productStockQuery = `
        SELECT ps.order_product_id, ps.quantity
        FROM product_stock ps
          JOIN order_product op ON ps.order_product_id = op.id
        WHERE op.order_id = ?
        ORDER BY ps.id;
      `;

      const [[orderRows], [orderProductRows], [productStockRows]] = (await Promise.all([
        db.execute(orderQuery, [orderId]),
        db.execute(orderProductQuery, [orderId]),
        db.execute(productStockQuery, [orderId]),
      ])) as SelectQueryResult[];

      return { orderRows, orderProductRows, productStockRows };
    };

    const assertData = (
      body: any,
      orderRows: any[],
      orderProductRows: any[],
      productStockRows: any[],
    ) => {
      expect(body).toMatchSnapshot('0_RESPONSE_BODY');
      expect(orderRows).toMatchSnapshot('1_ORDERS');
      expect(orderProductRows).toMatchSnapshot('2_ORDER_PRODUCTS');
      expect(productStockRows).toMatchSnapshot('3_PRODUCT_STOCK');
    };

    it('confirms all products and the order when every product has sufficient stock', async () => {
      const orderId = 1;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(apiHref(orderId));
      const { orderRows, orderProductRows, productStockRows } = await getDataToBeAsserted(orderId);

      expect(status).toBe(HttpStatus.OK);
      assertData(body, orderRows, orderProductRows, productStockRows);
    });

    it('confirms only products with available stock and leaves the order pending', async () => {
      const orderId = 2;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(apiHref(orderId));
      const { orderRows, orderProductRows, productStockRows } = await getDataToBeAsserted(orderId);

      expect(status).toBe(HttpStatus.OK);
      assertData(body, orderRows, orderProductRows, productStockRows);
    });

    it('leaves everything pending when there is no stock for any product', async () => {
      const orderId = 3;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(apiHref(orderId));
      const { orderRows, orderProductRows, productStockRows } = await getDataToBeAsserted(orderId);

      expect(status).toBe(HttpStatus.OK);
      assertData(body, orderRows, orderProductRows, productStockRows);
    });

    it('returns 400 when the order is already confirmed', async () => {
      const orderId = 4;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(apiHref(orderId));
      const { orderRows, orderProductRows, productStockRows } = await getDataToBeAsserted(orderId);

      expect(status).toBe(HttpStatus.BAD_REQUEST);
      assertData(body, orderRows, orderProductRows, productStockRows);
    });

    it('returns 404 when the order does not exist', async () => {
      const orderId = 0;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(apiHref(orderId));
      const { orderRows, orderProductRows, productStockRows } = await getDataToBeAsserted(orderId);

      expect(status).toBe(HttpStatus.NOT_FOUND);
      assertData(body, orderRows, orderProductRows, productStockRows);
    });
  });
});
