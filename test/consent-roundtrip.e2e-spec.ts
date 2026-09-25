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

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';

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

  const sendMarketingUntil = async (
    targetStatus: string,
    deadlineMs = 20_000,
  ): Promise<{ delivery: NotificationDeliveryView; campaignId: string }> => {
    const start = Date.now();
    for (let attempt = 0; ; attempt++) {
      const campaignId = `e2e-roundtrip-${stamp}-${targetStatus}-${attempt}`;
      const delivery = await sendMarketing(campaignId);
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
    expect(delivery.renderedBody).toContain(MARKETING_CONTEXT.customerName);
    expect(delivery.renderedBody).toContain(MARKETING_CONTEXT.promoCode);
    expect(delivery.renderedSubject).toContain(MARKETING_CONTEXT.customerName);

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
