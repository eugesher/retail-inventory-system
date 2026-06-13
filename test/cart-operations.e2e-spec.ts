import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

// Seeded customer (scripts/test-db-seed.ts). The seeded USD price of variant 1 is
// 4999 minor units (price.sql), which Add-to-Cart snapshots onto the line.
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const SEEDED_VARIANT_ID = 1;
const SEEDED_VARIANT_PRICE_MINOR = 4999;

interface ITokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface ICartLineBody {
  id: number;
  variantId: number;
  quantity: number;
  unitPriceSnapshotMinor: number;
  currencySnapshot: string;
  lineSubtotalMinor: number;
}

interface ICartBody {
  id: string;
  customerId: string | null;
  currency: string;
  status: string;
  lines: ICartLineBody[];
  subtotalMinor: number;
}

// A fresh second customer per run so the cross-owner 403 assertion never collides
// with a prior run's rows.
const secondCustomerEmail = (): string =>
  `cart-buyer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

describe('Cart operations (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  // The cart write path now reserves stock on add/change, so the inventory
  // microservice must be up to serve `inventory.reservation.*` on inventory_queue.
  let inventoryMicroservice: INestMicroservice;

  const login = async (email: string, password: string): Promise<string> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/customer/login')
      .send({ email, password });
    return (body as ITokenResponse).accessToken;
  };

  const registerAndLogin = async (): Promise<string> => {
    const email = secondCustomerEmail();
    await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/customer/register')
      .send({ email, password: CUSTOMER_PASSWORD });
    return login(email, CUSTOMER_PASSWORD);
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
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
  });

  describe('create → add → change → remove', () => {
    let accessToken: string;
    let cartId: string;
    let lineId: number;

    it('the seeded customer opens a cart', async () => {
      accessToken = await login(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/cart')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currency: 'USD' });

      expect(status).toBe(HttpStatus.CREATED);
      const cart = body as ICartBody;
      expect(cart.id).toEqual(expect.any(String));
      expect(cart.currency).toBe('USD');
      expect(cart.status).toBe('active');
      expect(cart.lines).toEqual([]);
      cartId = cart.id;
    });

    it('adds variant 1 (qty 2) and snapshots the seeded price', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/cart/${cartId}/lines`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ variantId: SEEDED_VARIANT_ID, quantity: 2 });

      expect(status).toBe(HttpStatus.OK);
      const cart = body as ICartBody;
      expect(cart.lines).toHaveLength(1);
      const [line] = cart.lines;
      expect(line.variantId).toBe(SEEDED_VARIANT_ID);
      expect(line.quantity).toBe(2);
      expect(line.unitPriceSnapshotMinor).toBe(SEEDED_VARIANT_PRICE_MINOR);
      expect(cart.subtotalMinor).toBe(SEEDED_VARIANT_PRICE_MINOR * 2);
      lineId = line.id;
    });

    it('rejects an unpriced/unknown variant with 409', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/cart/${cartId}/lines`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ variantId: 999999, quantity: 1 });

      expect(status).toBe(HttpStatus.CONFLICT);
    });

    it('changes the line quantity to 1', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch(`/api/cart/${cartId}/lines/${lineId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ quantity: 1 });

      expect(status).toBe(HttpStatus.OK);
      const cart = body as ICartBody;
      expect(cart.lines[0].quantity).toBe(1);
      expect(cart.subtotalMinor).toBe(SEEDED_VARIANT_PRICE_MINOR);
    });

    it('rejects quantity 0 (removal is the explicit op)', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .patch(`/api/cart/${cartId}/lines/${lineId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ quantity: 0 });

      expect(status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('removes the line, leaving the cart empty', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .delete(`/api/cart/${cartId}/lines/${lineId}`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(status).toBe(HttpStatus.OK);
      const cart = body as ICartBody;
      expect(cart.lines).toEqual([]);
      expect(cart.subtotalMinor).toBe(0);
    });
  });

  describe('authorization', () => {
    it('a second customer cannot GET the first customer’s cart (403)', async () => {
      const ownerToken = await login(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
      const create = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/cart')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});
      const cartId = (create.body as ICartBody).id;

      const intruderToken = await registerAndLogin();
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .get(`/api/cart/${cartId}`)
        .set('Authorization', `Bearer ${intruderToken}`);

      expect(status).toBe(HttpStatus.FORBIDDEN);
    });

    it('an unauthenticated create gets 401', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer()).post('/api/cart').send({});

      expect(status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('an unauthenticated get gets 401', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer()).get(
        '/api/cart/11111111-1111-4111-8111-111111111111',
      );

      expect(status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });
});
