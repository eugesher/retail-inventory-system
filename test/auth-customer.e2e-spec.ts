import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';

// Decode the JWT body without verifying the signature — the assertions only
// care about the claim shape, and the unit suite already covers verification.
const decodeJwtBody = (token: string): Record<string, unknown> => {
  const [, body] = token.split('.');
  if (!body) throw new Error('malformed JWT');
  const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
};

interface ITokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// Each run creates a fresh customer to avoid colliding with prior runs that
// may have left rows in the table. The seed script does not produce customer
// rows yet — a later seed-extension step will.
const customerEmail = (): string =>
  `buyer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const CUSTOMER_PASSWORD = 'customer1234';

describe('Customer auth flow (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;

  beforeAll(async () => {
    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );

    await apiGatewayApp.init();
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
  });

  describe('POST /api/auth/customer/register', () => {
    it('creates an active customer and returns the profile', async () => {
      const email = customerEmail();
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/customer/register')
        .send({ email, password: CUSTOMER_PASSWORD, firstName: 'Buyer', lastName: 'McShop' });

      expect(status).toBe(HttpStatus.CREATED);
      expect(body.id).toEqual(expect.any(String));
      expect(body.email).toBe(email);
      expect(body.status).toBe('active');
      expect(body.firstName).toBe('Buyer');
      expect(body.lastName).toBe('McShop');
      expect(body.emailVerifiedAt).toBeNull();
      expect(body).not.toHaveProperty('passwordHash');
    });

    it('rejects a duplicate email with 409', async () => {
      const email = customerEmail();
      const first = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/customer/register')
        .send({ email, password: CUSTOMER_PASSWORD });
      expect(first.status).toBe(HttpStatus.CREATED);

      const second = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/customer/register')
        .send({ email, password: CUSTOMER_PASSWORD });
      expect(second.status).toBe(HttpStatus.CONFLICT);
    });
  });

  describe('POST /api/auth/customer/login', () => {
    it('returns 401 when the password is wrong', async () => {
      const email = customerEmail();
      await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/customer/register')
        .send({ email, password: CUSTOMER_PASSWORD });

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/customer/login')
        .send({ email, password: 'WRONG-PASSWORD' });

      expect(status).toBe(HttpStatus.UNAUTHORIZED);
      expect(body).not.toHaveProperty('accessToken');
    });

    it('returns access + refresh tokens on success with empty roles/permissions in the access JWT', async () => {
      const email = customerEmail();
      await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/customer/register')
        .send({ email, password: CUSTOMER_PASSWORD });

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/customer/login')
        .send({ email, password: CUSTOMER_PASSWORD });

      expect(status).toBe(HttpStatus.OK);
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.refreshToken).toEqual(expect.any(String));
      expect(body.expiresIn).toEqual(expect.any(Number));

      const payload = decodeJwtBody((body as ITokenResponse).accessToken);
      expect(payload.roles).toEqual([]);
      expect(payload.permissions).toEqual([]);
      expect(payload.email).toBe(email);
    });
  });

  describe('GET /api/auth/customer/me', () => {
    it('returns the authenticated customer profile', async () => {
      const email = customerEmail();
      await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/customer/register')
        .send({ email, password: CUSTOMER_PASSWORD });

      const login = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/customer/login')
        .send({ email, password: CUSTOMER_PASSWORD });
      const tokens = login.body as ITokenResponse;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/customer/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.OK);
      expect(body.email).toBe(email);
      expect(body.status).toBe('active');
    });
  });

  describe('Customer JWT vs. permission-gated routes', () => {
    it('is rejected by /api/auth/admin/ping with 403', async () => {
      const email = customerEmail();
      await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/customer/register')
        .send({ email, password: CUSTOMER_PASSWORD });

      const login = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/customer/login')
        .send({ email, password: CUSTOMER_PASSWORD });
      const tokens = login.body as ITokenResponse;

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/admin/ping')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.FORBIDDEN);
      expect(body.message).toBe('Insufficient permissions');
    });
  });

  describe('Staff login deprecated alias + canonical path', () => {
    it('POST /api/auth/login (deprecated alias) still returns 200 for an admin', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'admin@example.com', password: 'admin1234' });

      expect(status).toBe(HttpStatus.OK);
      expect(body.accessToken).toEqual(expect.any(String));
    });

    it('POST /api/auth/staff/login (new canonical) returns 200 for an admin', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/auth/staff/login')
        .send({ email: 'admin@example.com', password: 'admin1234' });

      expect(status).toBe(HttpStatus.OK);
      expect(body.accessToken).toEqual(expect.any(String));
    });
  });
});
