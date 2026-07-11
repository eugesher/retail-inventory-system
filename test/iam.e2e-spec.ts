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

  // POST /api/iam/staff — the route ADR-047 added. `RegisterStaffUserUseCase` had been written,
  // unit-tested and registered as a provider since the identity baseline, but no controller ever
  // injected it: the only way to mint a staff principal was the seed script. The DI-graph sweep
  // is what found it.
  //
  // The test that matters is not the 201 — it is that the created user can then LOG IN. A 201
  // only proves a row was written; the login proves the argon2 hash and the role bundle are real
  // and that the new principal is a first-class one.
  describe('POST /api/iam/staff', () => {
    const NEW_STAFF_EMAIL = `staff-${Date.now()}@example.com`;
    const NEW_STAFF_PASSWORD = 'newstaff1234';

    it('rejects a caller without iam:staff-create with 403', async () => {
      // The warehouse fixture holds iam:assign-adjacent codes but not this one. Minting a
      // principal is a higher privilege than granting an existing one a role bundle — sharing a
      // code would make role assignment a silent user-creation escalation.
      const fixture = await login(FIXTURE_EMAIL, FIXTURE_PASSWORD);
      await supertest(apiGatewayApp.getHttpServer())
        .post('/api/iam/staff')
        .set('Authorization', `Bearer ${fixture.accessToken}`)
        .send({ email: 'nope@example.com', password: 'nope12345', roleNames: ['admin'] })
        .expect(HttpStatus.FORBIDDEN);
    });

    it('creates a staff user with its roles', async () => {
      const auth = await adminAuth();
      const { body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/iam/staff')
        .set('Authorization', auth)
        .send({
          email: NEW_STAFF_EMAIL,
          password: NEW_STAFF_PASSWORD,
          roleNames: ['warehouse-staff'],
        })
        .expect(HttpStatus.CREATED);

      const created = body as { id: string; email: string; roleNames: string[] };
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.email).toBe(NEW_STAFF_EMAIL);
      expect(created.roleNames).toEqual(['warehouse-staff']);
    });

    it('the created staff user can log in — the hash and the roles are real', async () => {
      const tokens = await login(NEW_STAFF_EMAIL, NEW_STAFF_PASSWORD);
      expect(tokens.accessToken).toEqual(expect.any(String));

      // ...and it carries the role's permissions, not an empty bundle: warehouse-staff has no
      // audit:read, so the guard chain must reject it exactly as it rejects the seeded fixture.
      await supertest(apiGatewayApp.getHttpServer())
        .get('/api/auth/admin/ping')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(HttpStatus.FORBIDDEN);
    });

    it('rejects a duplicate email with 409', async () => {
      const auth = await adminAuth();
      await supertest(apiGatewayApp.getHttpServer())
        .post('/api/iam/staff')
        .set('Authorization', auth)
        .send({
          email: NEW_STAFF_EMAIL,
          password: NEW_STAFF_PASSWORD,
          roleNames: ['warehouse-staff'],
        })
        .expect(HttpStatus.CONFLICT);
    });

    it('rejects an unknown role name with 400', async () => {
      const auth = await adminAuth();
      const { body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/iam/staff')
        .set('Authorization', auth)
        .send({
          email: `ghost-${Date.now()}@example.com`,
          password: 'ghost12345',
          roleNames: ['no-such-role'],
        })
        .expect(HttpStatus.BAD_REQUEST);
      expect((body as { message: string }).message).toContain('no-such-role');
    });

    it('rejects an empty roleNames with 400 — a principal that can do nothing is worse', async () => {
      const auth = await adminAuth();
      await supertest(apiGatewayApp.getHttpServer())
        .post('/api/iam/staff')
        .set('Authorization', auth)
        .send({ email: `empty-${Date.now()}@example.com`, password: 'empty12345', roleNames: [] })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });
});
