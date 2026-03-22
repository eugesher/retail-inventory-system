import { INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { createConnection } from 'mysql2/promise';
import type { Connection } from 'mysql2/promise';
import supertest = require('supertest');

import { MicroserviceQueueEnum } from '@retail-inventory-system/common';
import { AppModule as ApiGatewayAppModule } from '../apps/api-gateway/src/app';
import { AppModule as InventoryAppModule } from '../apps/inventory-microservice/src/app';
import { AppModule as RetailAppModule } from '../apps/retail-microservice/src/app';

// ── Seed data layout (auto-increment IDs after fresh migration + seed) ──────
//
//  Products:  1=Alpha(stock 5), 2=Beta(stock 3), 3=Gamma(stock 2), 4=Delta(no stock)
//  Customer:  1
//  Orders:    1=PENDING(full),  2=PENDING(partial),  3=PENDING(no-stock),  4=CONFIRMED
//  OrderProducts:
//    Order 1 → id 1(Alpha), id 2(Alpha), id 3(Beta)
//    Order 2 → id 4(Gamma), id 5(Gamma), id 6(Gamma)   ← only 2 units of Gamma available
//    Order 3 → id 7(Delta)
//    Order 4 → id 8(Alpha, already confirmed)

describe('PUT /api/order/:id/confirm', () => {
  let apiGatewayApp: INestApplication;
  let retailMs: INestMicroservice;
  let inventoryMs: INestMicroservice;
  let db: Connection;

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    // Start microservices first so their queues are declared before the
    // gateway's ClientProxy sends any messages.
    retailMs = await NestFactory.createMicroservice<MicroserviceOptions>(RetailAppModule, {
      logger: false,
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: MicroserviceQueueEnum.RETAIL_QUEUE,
        queueOptions: { durable: true },
      },
    });
    await retailMs.listen();

    inventoryMs = await NestFactory.createMicroservice<MicroserviceOptions>(InventoryAppModule, {
      logger: false,
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: MicroserviceQueueEnum.INVENTORY_QUEUE,
        queueOptions: { durable: true },
      },
    });
    await inventoryMs.listen();

    // Start the API gateway (no HTTP listen — supertest connects directly).
    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    db = await createConnection(process.env.DATABASE_URL!);
  }, 60_000);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMs?.close();
    await inventoryMs?.close();
    await db?.end();
  });

  // ── Happy path: full confirmation ─────────────────────────────────────────
  // Order 1 has 2 × Alpha + 1 × Beta. Both products have enough stock.
  // Expected: all 3 order-products → confirmed, order → confirmed.

  it('confirms all products and the order when every product has sufficient stock', async () => {
    const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(
      '/api/order/1/confirm',
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: 1,
      status: { id: 'confirmed', name: 'Confirmed', color: '35FF69' },
    });
    expect(body.products).toHaveLength(3);
    expect(body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 1,
          productId: 1,
          status: expect.objectContaining({ id: 'confirmed' }),
        }),
        expect.objectContaining({
          id: 2,
          productId: 1,
          status: expect.objectContaining({ id: 'confirmed' }),
        }),
        expect.objectContaining({
          id: 3,
          productId: 2,
          status: expect.objectContaining({ id: 'confirmed' }),
        }),
      ]),
    );

    // DB: order row
    const [orderRows] = (await db.execute('SELECT status_id FROM `order` WHERE id = 1')) as [
      any[],
      any[],
    ];
    expect(orderRows[0].status_id).toBe('confirmed');

    // DB: every order_product of order 1 is confirmed
    const [opRows] = (await db.execute(
      'SELECT status_id FROM order_product WHERE order_id = 1',
    )) as [any[], any[]];
    expect(opRows.every((r: any) => r.status_id === 'confirmed')).toBe(true);

    // DB: 3 stock-reservation records were inserted (quantity = -1 each)
    const [stockRows] = (await db.execute(
      'SELECT quantity FROM product_stock WHERE order_product_id IN (1, 2, 3)',
    )) as [any[], any[]];
    expect(stockRows).toHaveLength(3);
    expect(stockRows.every((r: any) => r.quantity === -1)).toBe(true);
  });

  // ── Happy path: partial confirmation ──────────────────────────────────────
  // Order 2 has 3 × Gamma but only 2 units in stock.
  // Expected: first 2 order-products → confirmed, third → pending, order → pending.

  it('confirms only products with available stock and leaves the order pending', async () => {
    const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(
      '/api/order/2/confirm',
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: 2,
      status: { id: 'pending' },
    });
    expect(body.products).toHaveLength(3);

    const confirmed = body.products.filter((p: any) => p.status.id === 'confirmed');
    const pending = body.products.filter((p: any) => p.status.id === 'pending');
    expect(confirmed).toHaveLength(2);
    expect(pending).toHaveLength(1);

    // DB: order stays pending
    const [orderRows] = (await db.execute('SELECT status_id FROM `order` WHERE id = 2')) as [
      any[],
      any[],
    ];
    expect(orderRows[0].status_id).toBe('pending');

    // DB: products processed in insertion order → first 2 confirmed, last one pending
    const [opRows] = (await db.execute(
      'SELECT id, status_id FROM order_product WHERE order_id = 2 ORDER BY id ASC',
    )) as [any[], any[]];
    expect(opRows[0].status_id).toBe('confirmed'); // id=4
    expect(opRows[1].status_id).toBe('confirmed'); // id=5
    expect(opRows[2].status_id).toBe('pending'); // id=6 – no stock left

    // DB: exactly 2 stock-reservation records (for ids 4 and 5)
    const [stockRows] = (await db.execute(
      'SELECT quantity FROM product_stock WHERE order_product_id IN (4, 5, 6)',
    )) as [any[], any[]];
    expect(stockRows).toHaveLength(2);
    expect(stockRows.every((r: any) => r.quantity === -1)).toBe(true);
  });

  // ── No stock ──────────────────────────────────────────────────────────────
  // Order 3 has 1 × Delta with zero stock.
  // Expected: no products confirmed, no stock records inserted, order stays pending.

  it('leaves everything pending when there is no stock for any product', async () => {
    const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(
      '/api/order/3/confirm',
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: 3,
      status: { id: 'pending' },
      products: [
        expect.objectContaining({
          id: 7,
          productId: 4,
          status: expect.objectContaining({ id: 'pending' }),
        }),
      ],
    });

    // DB: order unchanged
    const [orderRows] = (await db.execute('SELECT status_id FROM `order` WHERE id = 3')) as [
      any[],
      any[],
    ];
    expect(orderRows[0].status_id).toBe('pending');

    // DB: order_product unchanged
    const [opRows] = (await db.execute('SELECT status_id FROM order_product WHERE id = 7')) as [
      any[],
      any[],
    ];
    expect(opRows[0].status_id).toBe('pending');

    // DB: no stock records were inserted
    const [stockRows] = (await db.execute(
      'SELECT id FROM product_stock WHERE order_product_id = 7',
    )) as [any[], any[]];
    expect(stockRows).toHaveLength(0);
  });

  // ── Already confirmed ─────────────────────────────────────────────────────
  // Order 4 is already in 'confirmed' status.
  // The pipe must reject with 400 before the service is called.

  it('returns 400 when the order is already confirmed', async () => {
    const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(
      '/api/order/4/confirm',
    );

    expect(status).toBe(400);
    expect(body.message).toContain('cannot be confirmed');

    // DB: order status must not change
    const [orderRows] = (await db.execute('SELECT status_id FROM `order` WHERE id = 4')) as [
      any[],
      any[],
    ];
    expect(orderRows[0].status_id).toBe('confirmed');
  });

  // ── Order does not exist ──────────────────────────────────────────────────
  // Requesting confirmation for an ID that has no matching row in the DB.
  // The pipe fetches the order, gets null, and must throw NotFoundException.

  it('returns 404 when the order does not exist', async () => {
    const { status, body } = await supertest(apiGatewayApp.getHttpServer()).put(
      '/api/order/99999/confirm',
    );

    expect(status).toBe(404);
    expect(body.message).toContain('not found');
  });
});
