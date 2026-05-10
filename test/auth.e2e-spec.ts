import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/common';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

interface ITokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

describe('Auth flow (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;

  const login = async (email: string, password: string): Promise<ITokenResponse> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password });
    return body as ITokenResponse;
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
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await inventoryMicroservice?.close();
  });

  describe('protection of pre-existing routes', () => {
    it('returns 401 on POST /api/order without an Authorization header', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/order')
        .send({ customerId: 1, products: [{ productId: 1, quantity: 1 }] });
      expect(status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('returns 401 on GET /api/product/:productId/stock without an Authorization header', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer()).get('/api/product/1/stock');
      expect(status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns 401 when the password is wrong', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/login')
        .send({ email: CUSTOMER_EMAIL, password: 'WRONG-PASSWORD' });

      expect(status).toBe(HttpStatus.UNAUTHORIZED);
      expect(body).not.toHaveProperty('accessToken');
    });

    it('returns access + refresh tokens on success', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/login')
        .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });

      expect(status).toBe(HttpStatus.OK);
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.refreshToken).toEqual(expect.any(String));
      expect(body.expiresIn).toEqual(expect.any(Number));
    });
  });

  describe('Authenticated requests', () => {
    it('passes through to the route when a valid Bearer token is supplied', async () => {
      const tokens = await login(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/product/1/stock')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.OK);
    });

    it('returns the current user from GET /api/auth/me', async () => {
      const tokens = await login(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.OK);
      expect(body.email).toBe(CUSTOMER_EMAIL);
      expect(body.roles).toEqual(['customer']);
    });
  });

  describe('Refresh-token rotation', () => {
    it('rejects the original refresh token after a rotation', async () => {
      const tokens = await login(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

      // First refresh — succeeds and returns new tokens.
      const rotated = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: tokens.refreshToken });
      expect(rotated.status).toBe(HttpStatus.OK);
      expect(rotated.body.refreshToken).not.toBe(tokens.refreshToken);

      // Replay the original refresh token — must be rejected (rotation reuse).
      const replay = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: tokens.refreshToken });
      expect(replay.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('Role guard', () => {
    it('rejects a customer hitting an admin-only route with 403', async () => {
      const tokens = await login(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/admin/ping')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.FORBIDDEN);
    });

    it('admits an admin to the admin-only route', async () => {
      const tokens = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/admin/ping')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.OK);
      expect(body).toEqual({ ok: true });
    });
  });

  describe('Logout', () => {
    it('clears the refresh-token hash so subsequent refreshes fail', async () => {
      const tokens = await login(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

      const logout = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${tokens.accessToken}`);
      expect(logout.status).toBe(HttpStatus.OK);

      const replay = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: tokens.refreshToken });
      expect(replay.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });
});
