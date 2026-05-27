import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum, PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { RegisterStaffUserUseCase } from '../apps/api-gateway/src/modules/auth/application/use-cases/register-staff-user.use-case';

// Decode the JWT body without verifying the signature — the assertions only
// care about the claim shape, and the unit suite already covers verification.
const decodeJwtBody = (token: string): Record<string, unknown> => {
  const [, body] = token.split('.');
  if (!body) throw new Error('malformed JWT');
  const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
};

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
// One-off fixture: a `warehouse-staff` StaffUser registered in `beforeAll`
// to exercise the PermissionsGuard 403 path on `/api/auth/admin/ping`. The
// `warehouse-staff` role is seeded but bundles only `inventory:*` codes —
// it does NOT carry `audit:read`. Once task-09 ships the broader seed set
// this fixture step can be deleted and the assertion can log in against
// the seeded `warehouse@example.com` directly.
const WAREHOUSE_EMAIL = 'warehouse-staff@example.com';
const WAREHOUSE_PASSWORD = 'warehouse1234';
// TODO(task-05): customer credentials move under the `customer` aggregate;
// task-05 re-adds the seed against the `customer` table and re-enables the
// commented blocks below.
// const CUSTOMER_EMAIL = 'customer@example.com';
// const CUSTOMER_PASSWORD = 'customer1234';

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

    // Register a one-off non-admin StaffUser so the PermissionsGuard 403 path
    // on /api/auth/admin/ping has a caller without `audit:read`. Drop this in
    // favor of the seeded warehouse@example.com once task-09 ships.
    const register = apiGatewayApp.get(RegisterStaffUserUseCase);
    await register.execute({
      email: WAREHOUSE_EMAIL,
      password: WAREHOUSE_PASSWORD,
      roleNames: ['warehouse-staff'],
    });
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

  describe('POST /api/auth/login (admin)', () => {
    it('returns 401 when the password is wrong', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/login')
        .send({ email: ADMIN_EMAIL, password: 'WRONG-PASSWORD' });

      expect(status).toBe(HttpStatus.UNAUTHORIZED);
      expect(body).not.toHaveProperty('accessToken');
    });

    it('returns access + refresh tokens on success', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/login')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

      expect(status).toBe(HttpStatus.OK);
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.refreshToken).toEqual(expect.any(String));
      expect(body.expiresIn).toEqual(expect.any(Number));
    });

    it('inflates the permissions claim on the admin access JWT', async () => {
      const tokens = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const payload = decodeJwtBody(tokens.accessToken);
      expect(Array.isArray(payload.permissions)).toBe(true);
      const codes = payload.permissions as string[];
      // Admin is seeded with every code in the registry (see scripts/test-db-seed.ts).
      for (const code of Object.values(PermissionCodeEnum)) {
        expect(codes).toContain(code);
      }
      // Determinism: sorted ASC and free of duplicates.
      expect(codes).toEqual([...codes].sort());
      expect(new Set(codes).size).toBe(codes.length);
    });
  });

  // TODO(task-05): customer login flow lives at /api/auth/customer/login
  // once the Customer aggregate lands. Re-enable then.
  // describe('POST /api/auth/customer/login', () => {
  //   it('returns 401 when the password is wrong', async () => {
  //     const { status, body } = await supertest(apiGatewayApp.getHttpServer())
  //       .post('/api/auth/customer/login')
  //       .send({ email: CUSTOMER_EMAIL, password: 'WRONG-PASSWORD' });
  //
  //     expect(status).toBe(HttpStatus.UNAUTHORIZED);
  //     expect(body).not.toHaveProperty('accessToken');
  //   });
  //
  //   it('returns access + refresh tokens on success', async () => {
  //     const { status, body } = await supertest(apiGatewayApp.getHttpServer())
  //       .post('/api/auth/customer/login')
  //       .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
  //
  //     expect(status).toBe(HttpStatus.OK);
  //     expect(body.accessToken).toEqual(expect.any(String));
  //     expect(body.refreshToken).toEqual(expect.any(String));
  //     expect(body.expiresIn).toEqual(expect.any(Number));
  //   });
  // });

  describe('Authenticated admin requests', () => {
    it('passes through to the route when a valid Bearer token is supplied', async () => {
      const tokens = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/product/1/stock')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.OK);
    });

    it('returns the current user from GET /api/auth/me', async () => {
      const tokens = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.OK);
      expect(body.email).toBe(ADMIN_EMAIL);
      expect(body.roles).toEqual(['admin']);
      expect(Array.isArray(body.permissions)).toBe(true);
      expect(body.permissions).toContain(PermissionCodeEnum.AUDIT_READ);
    });
  });

  describe('Refresh-token rotation', () => {
    it('rejects the original refresh token after a rotation', async () => {
      const tokens = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

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

  // TODO(task-05): with the customer fixture restored, also assert that a
  // customer JWT (carrying an empty `permissions` claim) gets 403 here for
  // free — no `@RequiresPermission()`-gated route ever admits a customer.
  describe('Permissions guard (/api/auth/admin/ping)', () => {
    it('admits an admin (audit:read present in bundled permissions) with 200', async () => {
      const tokens = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/admin/ping')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.OK);
      expect(body).toEqual({ ok: true });
    });

    it('rejects a non-admin StaffUser (no audit:read) with 403 and "Insufficient permissions"', async () => {
      const tokens = await login(WAREHOUSE_EMAIL, WAREHOUSE_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/admin/ping')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.FORBIDDEN);
      expect(body.message).toBe('Insufficient permissions');
    });
  });

  describe('Logout', () => {
    it('clears the refresh-token hash so subsequent refreshes fail', async () => {
      const tokens = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

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
