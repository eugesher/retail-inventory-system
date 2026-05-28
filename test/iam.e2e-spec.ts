import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum, PermissionCodeEnum } from '@retail-inventory-system/contracts';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';

// The seeded `warehouse-staff` StaffUser (scripts/test-db-seed.ts) is the
// round-trip's assign/revoke target. `warehouse-staff` bundles only
// `inventory:*` codes — no `audit:read` — which gives the same "lacks the
// admin permission then gains it" arc the round-trip needs without an
// inline fixture. The id matches the seed's stable UUID so URL paths
// don't need a lookup step.
const FIXTURE_EMAIL = 'warehouse@example.com';
const FIXTURE_PASSWORD = 'warehouse1234';
const FIXTURE_STAFF_USER_ID = '00000000-0000-4000-a000-000000000004';
const FIXTURE_SEED_ROLE_NAME = 'warehouse-staff';

interface ITokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

describe('IAM admin endpoints (e2e)', () => {
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

  const adminAuth = async (): Promise<string> => {
    const tokens = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    return `Bearer ${tokens.accessToken}`;
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

  describe('Authorization gates', () => {
    it('rejects an unauthenticated GET /api/iam/roles with 401', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer()).get('/api/iam/roles');
      expect(status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('rejects a non-iam-edit caller on GET /api/iam/roles with 403', async () => {
      const fixtureTokens = await login(FIXTURE_EMAIL, FIXTURE_PASSWORD);
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/iam/roles')
        .set('Authorization', `Bearer ${fixtureTokens.accessToken}`);
      expect(status).toBe(HttpStatus.FORBIDDEN);
    });
  });

  describe('GET /api/iam/roles', () => {
    it('returns roles sorted by name ASC', async () => {
      const auth = await adminAuth();
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/iam/roles')
        .set('Authorization', auth);

      expect(status).toBe(HttpStatus.OK);
      const names = (body as { name: string }[]).map((r) => r.name);
      expect(names).toEqual([...names].sort());
      expect(names).toContain('admin');
      expect(names).toContain('order-support');
    });
  });

  describe('POST /api/iam/roles error paths', () => {
    it('returns 400 listing unknown permission codes', async () => {
      const auth = await adminAuth();
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/iam/roles')
        .set('Authorization', auth)
        .send({
          name: 'bogus-role',
          permissionCodes: ['inventory:nope'],
        });

      expect(status).toBe(HttpStatus.BAD_REQUEST);
      expect((body as { message: string }).message).toContain('inventory:nope');
    });

    it('returns 409 on a duplicate role name', async () => {
      const auth = await adminAuth();
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/iam/roles')
        .set('Authorization', auth)
        .send({
          name: 'admin',
          permissionCodes: [PermissionCodeEnum.AUDIT_READ],
        });
      expect(status).toBe(HttpStatus.CONFLICT);
    });
  });

  describe('Full round-trip: create → assign → probe → revoke → probe', () => {
    let createdRoleId: string;

    it('admin creates a custom audit-read role', async () => {
      const auth = await adminAuth();
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/iam/roles')
        .set('Authorization', auth)
        .send({
          name: 'iam-test-audit',
          description: 'IAM e2e fixture role',
          permissionCodes: [PermissionCodeEnum.AUDIT_READ],
        });

      expect(status).toBe(HttpStatus.CREATED);
      const role = body as { id: string; name: string; permissionCodes: string[] };
      expect(role.name).toBe('iam-test-audit');
      expect(role.permissionCodes).toEqual([PermissionCodeEnum.AUDIT_READ]);
      createdRoleId = role.id;
    });

    it('admin assigns the new role to the fixture staff user', async () => {
      const auth = await adminAuth();
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/iam/staff/${FIXTURE_STAFF_USER_ID}/roles`)
        .set('Authorization', auth)
        .send({ roleNames: ['iam-test-audit'] });

      expect(status).toBe(HttpStatus.OK);
      const out = body as { roleNames: string[] };
      expect(out.roleNames.sort()).toEqual(['iam-test-audit', FIXTURE_SEED_ROLE_NAME].sort());
    });

    it('re-assigning the same role is idempotent', async () => {
      const auth = await adminAuth();
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/iam/staff/${FIXTURE_STAFF_USER_ID}/roles`)
        .set('Authorization', auth)
        .send({ roleNames: ['iam-test-audit'] });

      expect(status).toBe(HttpStatus.OK);
      const out = body as { roleNames: string[] };
      expect(out.roleNames.sort()).toEqual(['iam-test-audit', FIXTURE_SEED_ROLE_NAME].sort());
    });

    it('fixture user can now hit /api/auth/admin/ping (audit:read inflated on login)', async () => {
      const tokens = await login(FIXTURE_EMAIL, FIXTURE_PASSWORD);
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/admin/ping')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.OK);
      expect(body).toEqual({ ok: true });
    });

    it('admin patches the role to drop the audit permission', async () => {
      const auth = await adminAuth();
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch(`/api/iam/roles/${createdRoleId}`)
        .set('Authorization', auth)
        .send({ permissionCodes: [PermissionCodeEnum.IAM_ROLE_EDIT] });

      expect(status).toBe(HttpStatus.OK);
      expect((body as { permissionCodes: string[] }).permissionCodes).toEqual([
        PermissionCodeEnum.IAM_ROLE_EDIT,
      ]);
    });

    it('admin revokes the role from the fixture staff user', async () => {
      const auth = await adminAuth();
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .delete(`/api/iam/staff/${FIXTURE_STAFF_USER_ID}/roles/iam-test-audit`)
        .set('Authorization', auth);
      expect(status).toBe(HttpStatus.NO_CONTENT);
    });

    it('revoking a role that is not bound returns 404 "Role not bound"', async () => {
      const auth = await adminAuth();
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .delete(`/api/iam/staff/${FIXTURE_STAFF_USER_ID}/roles/iam-test-audit`)
        .set('Authorization', auth);
      expect(status).toBe(HttpStatus.NOT_FOUND);
      expect((body as { message: string }).message).toBe('Role not bound');
    });

    it('revoking the last remaining role returns 409', async () => {
      const auth = await adminAuth();
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .delete(`/api/iam/staff/${FIXTURE_STAFF_USER_ID}/roles/${FIXTURE_SEED_ROLE_NAME}`)
        .set('Authorization', auth);
      expect(status).toBe(HttpStatus.CONFLICT);
      expect((body as { message: string }).message).toBe('Cannot revoke the last remaining role');
    });

    it('fixture user can no longer hit /api/auth/admin/ping after the revoke', async () => {
      const tokens = await login(FIXTURE_EMAIL, FIXTURE_PASSWORD);
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/admin/ping')
        .set('Authorization', `Bearer ${tokens.accessToken}`);

      expect(status).toBe(HttpStatus.FORBIDDEN);
    });

    it('PATCH with no fields returns 400 "No-op patch"', async () => {
      const auth = await adminAuth();
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch(`/api/iam/roles/${createdRoleId}`)
        .set('Authorization', auth)
        .send({});
      expect(status).toBe(HttpStatus.BAD_REQUEST);
      expect((body as { message: string }).message).toBe('No-op patch');
    });
  });
});
