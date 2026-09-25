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
      .post('/api/auth/staff/login')
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

    expect(row.action).toBe('StaffUserRolesAssigned');

    expect(row.actorType).toBe('staff-user');
    expect(row.actorId).toBe(ADMIN_STAFF_USER_ID);

    expect(row.entityType).toBe('staff-user');
    expect(row.entityId).toBe(TARGET_STAFF_USER_ID);

    expect(row.before).toBeNull();
    expect(row.after).not.toBeNull();
    expect(row.after).toMatchObject({ requestedRoleNames: [TARGET_SEED_ROLE] });

    expect(row.ipAddress).toBeNull();

    expect(row.correlationId).toBe(correlationId);
  });

  it('writes the audit row only to audit_log_entry, never to domain_event', async () => {
    const inDomainEvents = await eventStore.countDomainEventsByEventType('audit.staff.action');
    expect(inDomainEvents).toBe(0);
  });
});
