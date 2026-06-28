import { randomUUID } from 'crypto';

import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as EventStoreMicroserviceAppModule } from '@retail-inventory-system/apps/event-store-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import {
  EventStoreE2ESpecDataSource,
  IAuditLogEntryRowProjection,
} from './data-source/event-store.e2e-spec.data-source';

// Proves the staff audit trail end-to-end (ADR-035): an admin Assign Role through the
// gateway emits `audit.staff.action` onto the `ris.events` topic exchange, the event
// store's `FirehoseConsumer` routes it (alone among the firehose) to the audit-log
// ingest, and a row lands in the isolated `ris_eventstore.audit_log_entry`. The suite
// reads the row directly by SQL — there is no query endpoint (a deferred capability).
//
// The actual emitted `action` is the in-process `IAuditLogEvent.name` string,
// `'StaffUserRolesAssigned'` — NOT a permission code. The mapping records the whole
// payload as the `after` snapshot and leaves `before` null; `ip_address` is always
// null (no call site threads the request IP — a documented gap).
//
// The Assign Role re-assigns the seeded `warehouse-staff` user its EXISTING role: a
// valid, non-mutating Assign Role call (the audit publish is unconditional) that still
// produces the audit row without changing the shared fixture's role set — so it never
// disturbs the IAM suite that also exercises this user. The call carries a fixed
// `x-correlation-id`; the gateway threads it onto the audit event, so the row is found
// deterministically by that correlation id (the unrelated login audit carries its own).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const ADMIN_STAFF_USER_ID = '00000000-0000-4000-a000-000000000001';
const TARGET_STAFF_USER_ID = '00000000-0000-4000-a000-000000000004';
const TARGET_SEED_ROLE = 'warehouse-staff';
const CORRELATION_HEADER = 'x-correlation-id';

interface ITokenResponse {
  accessToken: string;
}

describe('Event store captures a staff Assign Role into the audit log (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let eventStoreMicroservice: INestMicroservice;
  let eventStore: EventStoreE2ESpecDataSource;

  const correlationId = `audit-${Date.now()}-${randomUUID()}`;
  let adminAuth: string;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  // Ingestion is asynchronous off the bus, so poll `audit_log_entry` by the assign
  // call's correlation id until the row appears, up to a bounded timeout.
  const waitForAuditRow = async (deadlineMs = 30_000): Promise<IAuditLogEntryRowProjection> => {
    const start = Date.now();
    for (;;) {
      const rows = await eventStore.getAuditLogEntriesByCorrelationId(correlationId);
      if (rows.length > 0) {
        return rows[0];
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error('Timed out waiting for the audit_log_entry row');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    // The audit flow is gateway-local (login + IAM role mutation, both over the auth
    // repositories) — the only microservice the suite needs is the event store, which
    // consumes the emitted `audit.staff.action` off the firehose.
    eventStoreMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      EventStoreMicroserviceAppModule,
      {
        logger: false,
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
    );
    await eventStoreMicroservice.listen();

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    eventStore = new EventStoreE2ESpecDataSource({
      type: 'mysql',
      url: process.env.EVENTSTORE_DATABASE_URL!,
      timezone: 'Z',
    });
    await eventStore.initialize();

    const adminLogin = await server()
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminAuth = `Bearer ${(adminLogin.body as ITokenResponse).accessToken}`;
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await eventStoreMicroservice?.close();
    await eventStore?.destroy();
  });

  it('records an Assign Role with the mapped actor / action / entity and an after snapshot', async () => {
    const assign = await server()
      .post(`/api/iam/staff/${TARGET_STAFF_USER_ID}/roles`)
      .set('Authorization', adminAuth)
      .set(CORRELATION_HEADER, correlationId)
      .send({ roleNames: [TARGET_SEED_ROLE] });
    expect(assign.status).toBe(HttpStatus.OK);

    const row = await waitForAuditRow();

    // The action is the in-process event name, not a permission code.
    expect(row.action).toBe('StaffUserRolesAssigned');

    // Actor: the admin who issued the call (staff token → `staff-user`).
    expect(row.actorType).toBe('staff-user');
    expect(row.actorId).toBe(ADMIN_STAFF_USER_ID);

    // Entity: the staff user the roles were assigned to.
    expect(row.entityType).toBe('staff-user');
    expect(row.entityId).toBe(TARGET_STAFF_USER_ID);

    // The mapping records the whole assignment payload as `after`, `before` null.
    expect(row.before).toBeNull();
    expect(row.after).not.toBeNull();
    expect(row.after).toMatchObject({ requestedRoleNames: [TARGET_SEED_ROLE] });

    // Documented gap: no call site threads the request IP.
    expect(row.ipAddress).toBeNull();

    // The correlation id rode the audit event end-to-end.
    expect(row.correlationId).toBe(correlationId);
  });

  it('writes the audit row only to audit_log_entry, never to domain_event', async () => {
    // `audit.staff.action` is the one routing key the dispatcher diverts away from the
    // domain-event ingest (ADR-035) — the two logs stay distinct.
    const inDomainEvents = await eventStore.countDomainEventsByEventType('audit.staff.action');
    expect(inDomainEvents).toBe(0);
  });
});
