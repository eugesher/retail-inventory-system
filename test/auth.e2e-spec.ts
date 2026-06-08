import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum, PermissionCodeEnum } from '@retail-inventory-system/contracts';

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
// Seeded by `yarn test:seed` (scripts/test-db-seed.ts) — the canonical
// `warehouse-staff` StaffUser. That role bundles only `inventory:*` codes,
// so the caller does NOT carry `audit:read` and the PermissionsGuard 403
// path on `/api/auth/admin/ping` is exercised without inline fixturing.
const WAREHOUSE_EMAIL = 'warehouse@example.com';
const WAREHOUSE_PASSWORD = 'warehouse1234';
// Stable id matches the seed script so future tests can reference the
// fixture by id without first looking it up by email.
const WAREHOUSE_STAFF_USER_ID = '00000000-0000-4000-a000-000000000004';
// Customer-side coverage lives in `test/auth-customer.e2e-spec.ts` — that
// spec drives the buyer aggregate through HTTP (register → login → me) and
// asserts the customer JWT is rejected by /api/auth/admin/ping.

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

    it('returns 401 on GET /api/auth/me without an Authorization header', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer()).get('/api/auth/me');
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

  describe('Authenticated admin requests', () => {
    it('passes through to the route when a valid Bearer token is supplied', async () => {
      const tokens = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/me')
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

  // The "customer JWT gets 403 here" assertion lives in
  // `test/auth-customer.e2e-spec.ts` so it can ride alongside the customer
  // register/login fixtures that produce that JWT.
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

      // Sanity-check: the access JWT resolves to the seeded warehouse staff
      // user id — guards against an accidental email collision masking the
      // 403 assertion below.
      const payload = decodeJwtBody(tokens.accessToken);
      expect(payload.sub).toBe(WAREHOUSE_STAFF_USER_ID);

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
