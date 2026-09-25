import { randomUUID } from 'crypto';

import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as EventStoreMicroserviceAppModule } from '@retail-inventory-system/apps/event-store-microservice';
import { MicroserviceQueueEnum, PermissionCodeEnum } from '@retail-inventory-system/contracts';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const ADMIN_STAFF_USER_ID = '00000000-0000-4000-a000-000000000001';
const WAREHOUSE_EMAIL = 'warehouse@example.com';
const WAREHOUSE_PASSWORD = 'warehouse1234';
const TARGET_STAFF_USER_ID = '00000000-0000-4000-a000-000000000004';
const TARGET_SEED_ROLE = 'warehouse-staff';
const CORRELATION_HEADER = 'x-correlation-id';

const ASSIGN_ROLE_ACTION = 'StaffUserRolesAssigned';
const PERMISSION_CODE_SHAPED_ACTION: string = PermissionCodeEnum.IAM_ASSIGN;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

const FORBIDDEN_SNAPSHOT_KEYS = ['email', 'passwordHash', 'password', 'phone'];

interface ITokenResponse {
  accessToken: string;
}

interface IAuditLogEntryItem {
  id: number;
  actorId: string | null;
  actorType: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  correlationId: string | null;
  occurredAt: string;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('GET /api/audit/entries — the staff audit trail read (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let eventStoreApp: INestApplication;

  const correlationId = `audit-entries-${Date.now()}-${randomUUID()}`;

  let adminAuth: string;
  let warehouseAuth: string;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const queryEntries = async (
    query: string,
    auth: string = adminAuth,
  ): Promise<supertest.Response> =>
    server().get(`/api/audit/entries${query}`).set('Authorization', auth);

  const waitForAssignRow = async (deadlineMs = 30_000): Promise<IAuditLogEntryItem[]> => {
    const start = Date.now();
    for (;;) {
      const res = await queryEntries(
        `?action=${ASSIGN_ROLE_ACTION}&correlationId=${correlationId}`,
      );
      expect(res.status).toBe(HttpStatus.OK);
      const page = res.body as IPageBody<IAuditLogEntryItem>;
      if (page.items.length > 0) {
        return page.items;
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for the ${ASSIGN_ROLE_ACTION} audit row`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    eventStoreApp = await NestFactory.create(EventStoreMicroserviceAppModule, { logger: false });
    eventStoreApp.connectMicroservice<MicroserviceOptions>(
      {
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          noAck: false,
          queue: MicroserviceQueueEnum.EVENT_STORE_FIREHOSE_QUEUE,
          queueOptions: { durable: true },
          exchange: 'ris.events',
          exchangeType: 'topic',
          wildcards: true,
        },
      },
      { inheritAppConfig: true },
    );
    eventStoreApp.connectMicroservice<MicroserviceOptions>(
      {
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          queue: MicroserviceQueueEnum.EVENT_STORE_QUERY_QUEUE,
          queueOptions: { durable: true },
        },
      },
      { inheritAppConfig: true },
    );
    await eventStoreApp.init();
    await eventStoreApp.startAllMicroservices();

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    const adminLogin = await server()
      .post('/api/auth/staff/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminAuth = `Bearer ${(adminLogin.body as ITokenResponse).accessToken}`;

    const warehouseLogin = await server()
      .post('/api/auth/staff/login')
      .send({ email: WAREHOUSE_EMAIL, password: WAREHOUSE_PASSWORD });
    warehouseAuth = `Bearer ${(warehouseLogin.body as ITokenResponse).accessToken}`;

    const assign = await server()
      .post(`/api/iam/staff/${TARGET_STAFF_USER_ID}/roles`)
      .set('Authorization', adminAuth)
      .set(CORRELATION_HEADER, correlationId)
      .send({ roleNames: [TARGET_SEED_ROLE] });
    expect(assign.status).toBe(HttpStatus.OK);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await eventStoreApp?.close();
  });

  it('finds the role assignment by its event-name action', async () => {
    const items = await waitForAssignRow();

    for (const item of items) {
      expect(item.action).toBe(ASSIGN_ROLE_ACTION);
      expect(item.correlationId).toBe(correlationId);
      expect(item.actorId).toBe(ADMIN_STAFF_USER_ID);
      expect(item.actorType).toBe('staff-user');
      expect(item.entityType).toBe('staff-user');
      expect(item.entityId).toBe(TARGET_STAFF_USER_ID);
    }
  });

  it('a permission code matches nothing — `action` is an event name', async () => {
    const res = await queryEntries(
      `?action=${encodeURIComponent(PERMISSION_CODE_SHAPED_ACTION)}&correlationId=${correlationId}`,
    );
    expect(res.status).toBe(HttpStatus.OK);
    expect((res.body as IPageBody<IAuditLogEntryItem>).total).toBe(0);
  });

  it('carries the change snapshot and no PII (ADR-037)', async () => {
    const items = await waitForAssignRow();

    for (const item of items) {
      expect(item.before).toBeNull();
      expect(item.after).not.toBeNull();
      expect(item.after).toMatchObject({ requestedRoleNames: [TARGET_SEED_ROLE] });

      const snapshots = JSON.stringify({ before: item.before, after: item.after });
      for (const key of FORBIDDEN_SNAPSHOT_KEYS) {
        expect(snapshots).not.toContain(key);
      }
    }
  });

  it('filters by the acting staff principal', async () => {
    const res = await queryEntries(
      `?actorId=${ADMIN_STAFF_USER_ID}&correlationId=${correlationId}`,
    );
    expect(res.status).toBe(HttpStatus.OK);
    const page = res.body as IPageBody<IAuditLogEntryItem>;

    expect(page.items.length).toBeGreaterThanOrEqual(1);
    for (const item of page.items) {
      expect(item.actorId).toBe(ADMIN_STAFF_USER_ID);
      expect(item.action).toBe(ASSIGN_ROLE_ACTION);
    }
  });

  it('defaults the page window to page 1, size 20', async () => {
    const res = await queryEntries('');
    expect(res.status).toBe(HttpStatus.OK);
    const page = res.body as IPageBody<IAuditLogEntryItem>;

    expect(page.page).toBe(DEFAULT_PAGE);
    expect(page.size).toBe(DEFAULT_PAGE_SIZE);
    expect(page.items.length).toBeLessThanOrEqual(DEFAULT_PAGE_SIZE);
  });

  it('gates the route on audit:read — a staff token without it gets 403, anonymous gets 401', async () => {
    const forbidden = await queryEntries('', warehouseAuth);
    expect(forbidden.status).toBe(HttpStatus.FORBIDDEN);

    const anonymous = await server().get('/api/audit/entries');
    expect(anonymous.status).toBe(HttpStatus.UNAUTHORIZED);
  });
});
