import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as NotificationMicroserviceAppModule } from '@retail-inventory-system/apps/notification-microservice';
import {
  ConsentRecordView,
  MicroserviceQueueEnum,
  NotificationDeliveryView,
} from '@retail-inventory-system/contracts';

// The customer consent round trip (ADR-037): a customer reads their defaults, opts INTO
// marketing, sees the change reflected on their own read AND on the admin staff-override
// read, then a marketing send to them is DISPATCHED (the consent cache refreshed from the
// `customer.consent.updated` event) — and finally, opting back OUT flips a later marketing
// send to `skipped-no-consent` (the reversal is proven end to end).
//
// Everything is asserted through PUBLIC STATE — the consent read endpoints and the gateway
// delivery audit query (`GET /api/notifications/deliveries`, staff `notifications:read`,
// ADR-033) — never an event spy. The marketing-send RPC is request-response, so the POST
// also returns the resulting delivery row synchronously; the suite cross-checks that
// against the audit query filtered to the send's marketing `campaignId` reference.
//
// The consent cache is kept fresh by the async `customer.consent.updated` consumer, so the
// reversal is polled (a fresh `campaignId` per attempt — distinct delivery rows) until a
// `skipped-no-consent` row appears, rather than assuming the cache has caught up.
//
// Self-provisioned throwaway customer (`e2e-consent-roundtrip-*`): the shared seeded
// `customer@example.com` other suites depend on is never touched.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';

// Rendered against the seeded `marketing.email.promo` template. Plain ASCII so Handlebars'
// default HTML-escaping leaves them verbatim in the body/subject to assert on.
const MARKETING_CONTEXT = { customerName: 'Ada Lovelace', promoCode: 'SAVE20' };

interface ITokenResponse {
  accessToken: string;
}

interface IRegisteredCustomer {
  id: string;
  email: string;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Consent round trip: read defaults, opt in, marketing sends, opt out (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let notificationMicroservice: INestMicroservice;

  const stamp = Date.now();
  const customerEmail = `e2e-consent-roundtrip-${stamp}@example.com`;
  const customerPassword = 'roundtrip1234';

  let adminAuth: string;
  let customerToken: string;
  let customerId: string;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const getMyConsent = async (): Promise<ConsentRecordView> => {
    const { body } = await server()
      .get('/api/auth/customer/me/consent')
      .set('Authorization', `Bearer ${customerToken}`);
    return body as ConsentRecordView;
  };

  const putMyConsent = async (patch: Record<string, unknown>): Promise<ConsentRecordView> => {
    const { body } = await server()
      .put('/api/auth/customer/me/consent')
      .set('Authorization', `Bearer ${customerToken}`)
      .send(patch);
    return body as ConsentRecordView;
  };

  const getAdminConsent = async (id: string): Promise<ConsentRecordView> => {
    const { body } = await server()
      .get(`/api/admin/customers/${id}/consent`)
      .set('Authorization', adminAuth);
    return body as ConsentRecordView;
  };

  // The marketing-send RPC is request-response — the POST body is the resulting delivery
  // row (sent / skipped-no-consent / a pre-existing duplicate), or empty when no template
  // resolves. A fresh `campaignId` per call makes each send a DISTINCT delivery row.
  const sendMarketing = async (campaignId: string): Promise<NotificationDeliveryView> => {
    const { body } = await server()
      .post('/api/notifications/marketing/send')
      .set('Authorization', adminAuth)
      .send({
        customerId,
        customerEmail,
        campaignId,
        context: MARKETING_CONTEXT,
      });
    return body as NotificationDeliveryView;
  };

  // Poll: send with a fresh `campaignId` each attempt until the returned delivery reaches
  // the target status. Absorbs the async consent-cache refresh — a just-changed preference
  // may not have propagated from the `customer.consent.updated` consumer to the cache yet,
  // so an early send can still reflect the prior state; a later one settles.
  const sendMarketingUntil = async (
    targetStatus: string,
    deadlineMs = 20_000,
  ): Promise<{ delivery: NotificationDeliveryView; campaignId: string }> => {
    const start = Date.now();
    for (let attempt = 0; ; attempt++) {
      const campaignId = `e2e-roundtrip-${stamp}-${targetStatus}-${attempt}`;
      const delivery = await sendMarketing(campaignId);
      // `status` is a NotificationDeliveryStatusEnum; coerce to string so the compare
      // is string-vs-string (the target is a plain string), and optional-chain the
      // empty-body ('' when no template resolves) case.
      const currentStatus = String(delivery?.status ?? 'empty');
      if (currentStatus === targetStatus) {
        return { delivery, campaignId };
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(
          `Timed out waiting for a marketing send to reach status '${targetStatus}' (last: ${currentStatus})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  };

  const listMarketingDeliveries = async (
    campaignId: string,
  ): Promise<NotificationDeliveryView[]> => {
    const { body } = await server()
      .get('/api/notifications/deliveries')
      .query({ eventReferenceType: 'marketing', eventReferenceId: campaignId })
      .set('Authorization', adminAuth);
    return (body as IPageBody<NotificationDeliveryView>).items;
  };

  beforeAll(async () => {
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

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

    const register = await server()
      .post('/api/auth/customer/register')
      .send({ email: customerEmail, password: customerPassword });
    expect(register.status).toBe(HttpStatus.CREATED);
    customerId = (register.body as IRegisteredCustomer).id;

    const login = await server()
      .post('/api/auth/customer/login')
      .send({ email: customerEmail, password: customerPassword });
    customerToken = (login.body as ITokenResponse).accessToken;
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await notificationMicroservice?.close();
  });

  it('reads the consent defaults for a customer with no stored row', async () => {
    const consent = await getMyConsent();

    expect(consent.customerId).toBe(customerId);
    expect(consent.transactionalEmail).toBe(true);
    expect(consent.marketingEmail).toBe(false);
    expect(consent.marketingSms).toBe(false);
  });

  it('opts into marketing and reads the change back on the customer’s own endpoint', async () => {
    const updated = await putMyConsent({ marketingEmail: true });
    expect(updated.marketingEmail).toBe(true);

    const readBack = await getMyConsent();
    expect(readBack.marketingEmail).toBe(true);
    // The opt-in did not disturb the transactional default.
    expect(readBack.transactionalEmail).toBe(true);
  });

  it('surfaces the same opt-in on the admin staff-override consent read', async () => {
    const adminView = await getAdminConsent(customerId);
    expect(adminView.customerId).toBe(customerId);
    expect(adminView.marketingEmail).toBe(true);
  });

  it('dispatches a marketing send to the opted-in customer, rendered from the seeded template', async () => {
    const { delivery, campaignId } = await sendMarketingUntil('sent');

    expect(delivery.status).toBe('sent');
    expect(delivery.channel).toBe('email');
    expect(delivery.eventReferenceType).toBe('marketing');
    expect(delivery.recipientCustomerId).toBe(customerId);
    expect(delivery.recipientAddress).toBe(customerEmail);
    // Rendered from the seeded `marketing.email.promo` template against the send context.
    expect(delivery.renderedBody).toContain(MARKETING_CONTEXT.customerName);
    expect(delivery.renderedBody).toContain(MARKETING_CONTEXT.promoCode);
    expect(delivery.renderedSubject).toContain(MARKETING_CONTEXT.customerName);

    // Cross-check through the gateway audit query, filtered to this send's reference:
    // exactly one row, and it is the `sent` one.
    const rows = await listMarketingDeliveries(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');
    expect(rows[0].recipientAddress).toBe(customerEmail);
  });

  it('flips a later marketing send to skipped-no-consent after opting back out', async () => {
    const reverted = await putMyConsent({ marketingEmail: false });
    expect(reverted.marketingEmail).toBe(false);

    const { delivery, campaignId } = await sendMarketingUntil('skipped-no-consent');

    expect(delivery.status).toBe('skipped-no-consent');
    expect(delivery.attemptCount).toBe(0);
    expect(delivery.recipientCustomerId).toBe(customerId);

    const rows = await listMarketingDeliveries(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped-no-consent');
  });
});
