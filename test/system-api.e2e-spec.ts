import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Connection, createConnection } from 'mysql2/promise';
import supertest = require('supertest');

import { MicroserviceQueueEnum } from '@retail-inventory-system/common';
import { AppModule as ApiGatewayAppModule } from '../apps/api-gateway/src/app';
import { AppModule as InventoryAppModule } from '../apps/inventory-microservice/src/app';
import { AppModule as RetailAppModule } from '../apps/retail-microservice/src/app';

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
      RetailAppModule,
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
      InventoryAppModule,
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

  describe('PUT /api/order/:id/confirm', () => {
    const apiHref = (orderId: number) => `/api/order/${orderId}/confirm`;

    const getProductStockByOrderId = async (orderId: number) => {
      const [rows] = (await db.execute(
        `SELECT ps.order_product_id, ps.quantity
         FROM product_stock ps
         JOIN order_product op ON ps.order_product_id = op.id
         WHERE op.order_id = ?
         ORDER BY ps.id ASC`,
        [orderId],
      )) as SelectQueryResult;
      return rows;
    };

    it('confirms all products and the order when every product has sufficient stock', async () => {
      const orderId = 1;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(apiHref(orderId));

      const [orderRows] = (await db.execute('SELECT status_id FROM `order` WHERE id = ?', [
        orderId,
      ])) as SelectQueryResult;
      const [orderProductRows] = (await db.execute(
        'SELECT id, status_id FROM order_product WHERE order_id = ? ORDER BY id ASC',
        [orderId],
      )) as SelectQueryResult;
      const productStockRows = await getProductStockByOrderId(orderId);

      expect(status).toBe(HttpStatus.OK);
      expect(body).toMatchSnapshot('0_RESPONSE_BODY');
      expect(orderRows).toMatchSnapshot('1_ORDERS');
      expect(orderProductRows).toMatchSnapshot('2_ORDER_PRODUCTS');
      expect(productStockRows).toMatchSnapshot('3_PRODUCT_STOCK');
    });

    it('confirms only products with available stock and leaves the order pending', async () => {
      const orderId = 2;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(apiHref(orderId));

      const [orderRows] = (await db.execute('SELECT status_id FROM `order` WHERE id = ?', [
        orderId,
      ])) as SelectQueryResult;
      const [orderProductRows] = (await db.execute(
        'SELECT id, status_id FROM order_product WHERE order_id = ? ORDER BY id ASC',
        [orderId],
      )) as SelectQueryResult;
      const productStockRows = await getProductStockByOrderId(orderId);

      expect(status).toBe(HttpStatus.OK);
      expect(body).toMatchSnapshot('0_RESPONSE_BODY');
      expect(orderRows).toMatchSnapshot('1_ORDERS');
      expect(orderProductRows).toMatchSnapshot('2_ORDER_PRODUCTS');
      expect(productStockRows).toMatchSnapshot('3_PRODUCT_STOCK');
    });

    it('leaves everything pending when there is no stock for any product', async () => {
      const orderId = 3;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(apiHref(orderId));

      const [orderRows] = (await db.execute('SELECT status_id FROM `order` WHERE id = ?', [
        orderId,
      ])) as SelectQueryResult;
      const [orderProductRows] = (await db.execute(
        'SELECT id, status_id FROM order_product WHERE order_id = ? ORDER BY id ASC',
        [orderId],
      )) as SelectQueryResult;
      const productStockRows = await getProductStockByOrderId(orderId);

      expect(status).toBe(HttpStatus.OK);
      expect(body).toMatchSnapshot('0_RESPONSE_BODY');
      expect(orderRows).toMatchSnapshot('1_ORDERS');
      expect(orderProductRows).toMatchSnapshot('2_ORDER_PRODUCTS');
      expect(productStockRows).toMatchSnapshot('3_PRODUCT_STOCK');
    });

    it('returns 400 when the order is already confirmed', async () => {
      const orderId = 4;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(apiHref(orderId));

      const [orderRows] = (await db.execute('SELECT status_id FROM `order` WHERE id = ?', [
        orderId,
      ])) as SelectQueryResult;
      const [orderProductRows] = (await db.execute(
        'SELECT id, status_id FROM order_product WHERE order_id = ? ORDER BY id ASC',
        [orderId],
      )) as SelectQueryResult;
      const productStockRows = await getProductStockByOrderId(orderId);

      expect(status).toBe(HttpStatus.BAD_REQUEST);
      expect(body).toMatchSnapshot('0_RESPONSE_BODY');
      expect(orderRows).toMatchSnapshot('1_ORDERS');
      expect(orderProductRows).toMatchSnapshot('2_ORDER_PRODUCTS');
      expect(productStockRows).toMatchSnapshot('3_PRODUCT_STOCK');
    });

    it('returns 404 when the order does not exist', async () => {
      const orderId = 0;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(apiHref(orderId));

      expect(status).toBe(HttpStatus.NOT_FOUND);
      expect(body).toMatchSnapshot('0_RESPONSE_BODY');
    });
  });
});
