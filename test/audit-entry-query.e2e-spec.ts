import { randomUUID } from 'crypto';

import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as EventStoreMicroserviceAppModule } from '@retail-inventory-system/apps/event-store-microservice';
import { MicroserviceQueueEnum, PermissionCodeEnum } from '@retail-inventory-system/contracts';

// `GET /api/audit/entries` — the operator read of the event store's `audit_log_entry`
// staff trail (ADR-039). Where `/audit/events` answers "what did the system do", this one
// answers "what did a PERSON do".
//
// THE `action` TRAP, pinned here on purpose. `action` takes the stable in-process
// `IAuditLogEvent.name` string — `StaffUserRolesAssigned` — and never a `PermissionCodeEnum`
// value (an `<area>:<verb>` string). The ingest maps `action ← name` (ADR-035), so a
// permission code silently matches nothing and reads as "no such action ever happened".
// The literal asserted below is the one `AssignStaffRoleUseCase` publishes; it is the
// contract, not a description.
//
// The fixture Assign Role RE-ASSIGNS the seeded `warehouse-staff` user its EXISTING role.
// That is a valid, non-mutating call — the audit publish is unconditional — so the row
// appears without disturbing the shared fixture the IAM suite also drives. The call rides
// a fixed `x-correlation-id`, which makes the row findable deterministically rather than
// by hoping it is the newest one.
//
// NO ASSERTION ON ROW COUNT. `audit_log_entry` has no dedupe key (unlike `domain_event`'s
// composite UNIQUE), so an at-least-once redelivery appends a second identical row. The
// suite asserts that the matched rows are all the RIGHT row, never that there is one.
//
// The event store connects both transports (the firehose ingests the emitted
// `audit.staff.action`; the query queue answers the read), so this mirrors its hybrid
// `main.ts` boot. The audit flow itself is gateway-local — login plus an IAM mutation over
// the auth repositories — so no other microservice is needed.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const ADMIN_STAFF_USER_ID = '00000000-0000-4000-a000-000000000001';
const WAREHOUSE_EMAIL = 'warehouse@example.com';
const WAREHOUSE_PASSWORD = 'warehouse1234';
const TARGET_STAFF_USER_ID = '00000000-0000-4000-a000-000000000004';
const TARGET_SEED_ROLE = 'warehouse-staff';
const CORRELATION_HEADER = 'x-correlation-id';

// The `IAuditLogEvent.name` `AssignStaffRoleUseCase` publishes. NOT a permission code.
const ASSIGN_ROLE_ACTION = 'StaffUserRolesAssigned';
// The code that GATES the assignment endpoint, taken from the enum rather than spelled out:
// the negative test below proves it is not what the endpoint RECORDED.
const PERMISSION_CODE_SHAPED_ACTION: string = PermissionCodeEnum.IAM_ASSIGN;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

// ADR-037: an audit row is a record of WHAT changed, never of who the customer is. No
// snapshot may carry PII or a credential.
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

  // Ingestion is asynchronous off the bus, so poll the query API until the row lands.
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

    // The hybrid boot of the event store's `main.ts`: two transports, `init()` first,
    // `listen()` never. Without the query transport an `/api/audit/*` call would HANG —
    // the durable queue accepts the RPC and nobody replies.
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
      // The acting principal is the admin who issued the call; a staff token maps to
      // `staff-user`.
      expect(item.actorId).toBe(ADMIN_STAFF_USER_ID);
      expect(item.actorType).toBe('staff-user');
      // The entity is the staff user the roles landed on.
      expect(item.entityType).toBe('staff-user');
      expect(item.entityId).toBe(TARGET_STAFF_USER_ID);
    }
  });

  it('a permission code matches nothing — `action` is an event name', async () => {
    // The trap, asserted rather than merely commented: the code that authorizes the call is
    // not the name of what the call recorded.
    const res = await queryEntries(
      `?action=${encodeURIComponent(PERMISSION_CODE_SHAPED_ACTION)}&correlationId=${correlationId}`,
    );
    expect(res.status).toBe(HttpStatus.OK);
    expect((res.body as IPageBody<IAuditLogEntryItem>).total).toBe(0);
  });

  it('carries the change snapshot and no PII (ADR-037)', async () => {
    const items = await waitForAssignRow();

    for (const item of items) {
      // The mapping records the whole assignment payload as `after` and leaves `before`
      // null — a role assignment has no prior snapshot to diff against.
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
    // Scoped by correlation id as well: the admin logs in from every suite in the run, and
    // an unscoped `actorId` page would be a moving target, not an assertion.
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

    // Neither defaulted nor capped at the gateway: `clampPageWindow` in the event store's
    // use case is the single expression of the rule.
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
