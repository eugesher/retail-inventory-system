import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';

import { ConsentErasureE2ESpecDataSource } from './data-source/consent-erasure.e2e-spec.data-source';

// The confirm-email guard on the irreversible tombstone-erase (ADR-037 §2). The admin
// must retype the customer's CURRENT email; a mismatch is a `400` and NOTHING is written
// — the guard is the third gate in the erase sequence (after not-found + the
// idempotent-on-deleted short-circuit), placed BEFORE any PII nulling.
//
// This suite boots ONLY the gateway: the erase runs entirely gateway-side (the auth
// module's raw-SQL `CUSTOMER_ERASURE_WRITER` on the gateway's own retail_db connection —
// no retail/catalog/inventory RPC), and a wrong `confirmEmail` never even reaches the
// writer. The proof that "nothing changed" is read straight from the `customer` row via a
// read-only data-source (there is no admin "read customer" endpoint).
//
// Self-provisioned throwaway customer (`e2e-confirm-guard-*`): the shared seeded
// `customer@example.com` other suites depend on is never touched.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';

interface ITokenResponse {
  accessToken: string;
}

interface IRegisteredCustomer {
  id: string;
  email: string;
  status: string;
}

describe('Erase customer — confirm-email guard rejects a mismatch and writes nothing (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let dataSource: ConsentErasureE2ESpecDataSource;

  const stamp = Date.now();
  const customerEmail = `e2e-confirm-guard-${stamp}@example.com`;
  const customerPassword = 'guard1234';

  let adminAuth: string;
  let customerId: string;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  beforeAll(async () => {
    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    dataSource = new ConsentErasureE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

    const register = await server()
      .post('/api/auth/customer/register')
      .send({ email: customerEmail, password: customerPassword });
    expect(register.status).toBe(HttpStatus.CREATED);
    customerId = (register.body as IRegisteredCustomer).id;
    expect(customerId).toBeTruthy();
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await dataSource?.destroy();
  });

  it('rejects an erase whose confirmEmail does not match the customer', async () => {
    const res = await server()
      .post(`/api/admin/customers/${customerId}/erase`)
      .set('Authorization', adminAuth)
      .send({ confirmEmail: 'wrong@example.com' });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('leaves the customer completely unchanged — the guard wrote nothing', async () => {
    const row = await dataSource.getCustomerById(customerId);

    expect(row).toBeDefined();
    // The account is still live: status intact, email intact, no tombstone marker.
    expect(row!.status).toBe('active');
    expect(row!.email).toBe(customerEmail);
    expect(row!.deletedAt).toBeNull();
  });
});
