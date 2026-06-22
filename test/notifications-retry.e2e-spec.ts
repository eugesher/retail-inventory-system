import { randomUUID } from 'node:crypto';

import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ClientProxy,
  ClientProxyFactory,
  MicroserviceOptions,
  Transport,
} from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as NotificationMicroserviceAppModule } from '@retail-inventory-system/apps/notification-microservice';
import {
  IRetailOrderPlacedEvent,
  MicroserviceQueueEnum,
  NotificationDeliveryView,
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { FLAKY_NOTIFIER_FAIL_MARKER } from '../apps/notification-microservice/src/modules/notifications/infrastructure/delivery/flaky-log.notifier.adapter';

// A failed delivery is recovered by the manual retry route (ADR-033). This suite turns on
// the test-only flaky NOTIFIER (`NOTIFIER_TEST_FLAKY`, set before the notification
// microservice boots), authors — over the gateway — a `retail.order.placed` template whose
// body carries the fail-once marker, then publishes a synthetic `retail.order.placed` event
// (the disjoint, per-run `orderId`/`customerId` keep it isolated). The first dispatch fails
// (the flaky adapter rejects a marked body once), so the delivery lands `failed` with
// `attempt_count = 1`. Driving the manual retry route
// (`POST /api/notifications/deliveries/:id/retry`, which re-dispatches the already-rendered
// content and ignores the backoff gate) flips it to `sent` with `attempt_count = 2`.
//
// Everything is asserted through PUBLIC STATE — the gateway delivery audit query + the retry
// route's own response — never an event spy. The synthetic publish mirrors the existing
// notification flow e2e, keeping the flaky path deterministic without booting retail/catalog/
// inventory. (The scheduled-sweeper retry is covered by the unit spec.)
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const RECIPIENT_EMAIL = 'retry-e2e@example.com';

interface ITokenResponse {
  accessToken: string;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Notifications — manual retry recovers a failed delivery (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let notificationMicroservice: INestMicroservice;
  let publisher: ClientProxy;

  const stamp = Date.now();
  // Disjoint per-run identity so the delivery (and its dedupe key) never collides with
  // another run's row or another suite's order.
  const orderId = 900_000_000 + (stamp % 90_000_000);
  const orderNumber = `ORD-RETRY-${stamp}`;
  const customerId = randomUUID();
  let adminAuth: string;
  let flakyFlagBefore: string | undefined;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const listOrderDeliveries = async (status?: string): Promise<NotificationDeliveryView[]> => {
    const { body } = await server()
      .get('/api/notifications/deliveries')
      .query({
        eventReferenceType: 'order',
        eventReferenceId: String(orderId),
        ...(status && { status }),
      })
      .set('Authorization', adminAuth);
    return (body as IPageBody<NotificationDeliveryView>).items;
  };

  const waitForDelivery = async (
    status: string,
    deadlineMs = 20_000,
  ): Promise<NotificationDeliveryView> => {
    const start = Date.now();
    for (;;) {
      const rows = await listOrderDeliveries(status);
      if (rows.length > 0) {
        return rows[0];
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for a ${status} delivery for order ${orderId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    // Turn on the flaky NOTIFIER for THIS microservice instance only. Set before boot so the
    // module's wiring-time selection picks the flaky adapter; restored in afterAll so no later
    // suite inherits it.
    flakyFlagBefore = process.env.NOTIFIER_TEST_FLAKY;
    process.env.NOTIFIER_TEST_FLAKY = 'true';

    const rmqUrl = process.env.RABBITMQ_URL!;

    notificationMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      NotificationMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          queue: MicroserviceQueueEnum.NOTIFICATION_EVENTS,
          queueOptions: { durable: true },
        },
      },
    );
    await notificationMicroservice.listen();

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    publisher = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: MicroserviceQueueEnum.NOTIFICATION_EVENTS,
        queueOptions: { durable: true },
      },
    });
    await publisher.connect();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

    // Author the marker template as the newest active `retail.order.placed` version. Its body
    // carries the fail-once marker; it keeps `{{orderNumber}}` so it stays a superset of the
    // seeded body (other suites that render it succeed under their non-flaky notifier).
    const authorRes = await server()
      .post('/api/notifications/templates')
      .set('Authorization', adminAuth)
      .send({
        eventType: ROUTING_KEYS.RETAIL_ORDER_PLACED,
        channel: 'email',
        locale: 'en-US',
        subject: 'Order #{{orderNumber}} confirmed',
        body: `Order #{{orderNumber}} confirmed. ${FLAKY_NOTIFIER_FAIL_MARKER}`,
      });
    expect(authorRes.status).toBe(HttpStatus.CREATED);
    expect((authorRes.body as NotificationTemplateView).active).toBe(true);
  }, timeout);

  afterAll(async () => {
    await publisher?.close();
    await apiGatewayApp?.close();
    await notificationMicroservice?.close();
    // Restore the flag so a later suite's notification microservice is not flaky.
    if (flakyFlagBefore === undefined) {
      delete process.env.NOTIFIER_TEST_FLAKY;
    } else {
      process.env.NOTIFIER_TEST_FLAKY = flakyFlagBefore;
    }
  });

  it('the first dispatch fails — the delivery lands failed with attempt_count 1', async () => {
    const event: IRetailOrderPlacedEvent = {
      correlationId: `retry-e2e-${stamp}`,
      orderId,
      orderNumber,
      customerId,
      customerEmail: RECIPIENT_EMAIL,
      customerLocale: null,
      grandTotalMinor: 4999,
      currency: 'USD',
      lineCount: 1,
      eventVersion: 'v1',
      occurredAt: new Date().toISOString(),
    };
    await firstValueFrom(publisher.emit(ROUTING_KEYS.RETAIL_ORDER_PLACED, event));

    const failed = await waitForDelivery('failed');
    expect(failed.status).toBe('failed');
    expect(failed.attemptCount).toBe(1);
    expect(failed.failureReason).toBeTruthy();
    expect(failed.recipientAddress).toBe(RECIPIENT_EMAIL);
  });

  it('the manual retry route re-dispatches it to sent with attempt_count 2', async () => {
    const failed = (await listOrderDeliveries('failed'))[0];

    const retryRes = await server()
      .post(`/api/notifications/deliveries/${failed.id}/retry`)
      .set('Authorization', adminAuth);
    expect(retryRes.status).toBe(HttpStatus.OK);

    const retried = retryRes.body as NotificationDeliveryView;
    expect(retried.id).toBe(failed.id);
    expect(retried.status).toBe('sent');
    expect(retried.attemptCount).toBe(2);

    // And the public audit trail agrees — the same row is now sent.
    const sent = await listOrderDeliveries('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe(failed.id);
    expect(sent[0].attemptCount).toBe(2);
  });
});
