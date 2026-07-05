import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as NotificationMicroserviceAppModule } from '@retail-inventory-system/apps/notification-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import {
  MicroserviceQueueEnum,
  NotificationDeliveryView,
} from '@retail-inventory-system/contracts';

import { InventoryAutoInitE2ESpecDataSource } from './data-source/inventory-auto-init.e2e-spec.data-source';

// The notification consent-gate (ADR-037), proven both ways against ONE fresh customer who
// carries the capability defaults (transactionalEmail=true, marketingEmail=false):
//
//   - NEGATIVE (marketing gated): a marketing send is classified against `marketingEmail`.
//     With marketing off, the gate persists a TERMINAL `skipped-no-consent` row BEFORE and
//     INSTEAD OF the NOTIFIER call — `attemptCount=0`, never `sent`. The NOTIFIER is never
//     invoked (an unconsented marketing email is not merely un-attempted — it is recorded
//     as skipped and dispatched nowhere).
//
//   - POSITIVE control (transactional bypass): a real placed order emits
//     `retail.order.placed` — a TRANSACTIONAL event — which the gate classifies against
//     `transactionalEmail` (the bypass), NOT marketing. Even with marketing OFF, the same
//     customer still gets a `sent` order-confirmation delivery. This is what makes the
//     gate a marketing filter, not a blanket mute.
//
// Both consent reads hit the SAME cached snapshot for the customer, so the two outcomes
// (skip vs send) turn purely on the event classification, not on differing consent.
//
// Asserted through PUBLIC STATE — the marketing-send RPC response + the gateway delivery
// audit query (`GET /api/notifications/deliveries`, ADR-033) — never an event spy.
// Self-provisioned, disjoint fixtures (`e2e-consent-gate-*`).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';

const ADDRESS = {
  recipientName: 'Jane Buyer',
  line1: '1 Market St',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94105',
  country: 'US',
};

interface ITokenResponse {
  accessToken: string;
}

interface IRegisteredCustomer {
  id: string;
}

interface ICartBody {
  id: string;
}

interface IOrderBody {
  id: number;
  orderNumber: string;
  status: string;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Notification consent-gate: marketing skipped, transactional bypassed (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let notificationMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  const customerEmail = `e2e-consent-gate-${stamp}@example.com`;
  const customerPassword = 'gating1234';

  let adminAuth: string;
  let customerToken: string;
  let customerId: string;
  let variantId: number;
  let order: IOrderBody;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const waitForStockRow = async (variant: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRows(variant)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variant}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const provisionVariant = async (label: string, onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Consent Gate ${label} ${stamp}`,
        slug: `e2e-consent-gate-${label}-${stamp}`,
        description: 'consent-gating fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({
        sku: `E2E-CONSENTGATE-${label}-${stamp}`,
        optionValues: { color: 'black', size: 'M' },
      });
    const variant = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variant}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });
    expect(priceRes.status).toBe(HttpStatus.CREATED);

    await settleTimestampRounding();

    const publishRes = await server()
      .post(`/api/catalog/products/${productId}/publish`)
      .set('Authorization', adminAuth);
    expect(publishRes.status).toBe(HttpStatus.OK);

    await waitForStockRow(variant);

    const receiveRes = await server()
      .post(`/api/inventory/variants/${variant}/stock/receive`)
      .set('Authorization', adminAuth)
      .send({ quantity: onHand });
    expect(receiveRes.status).toBe(HttpStatus.OK);

    return variant;
  };

  const listOrderDeliveries = async (
    orderId: number,
    status?: string,
  ): Promise<NotificationDeliveryView[]> => {
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

  const waitForSentOrderDelivery = async (
    orderId: number,
    deadlineMs = 20_000,
  ): Promise<NotificationDeliveryView> => {
    const start = Date.now();
    for (;;) {
      const sent = await listOrderDeliveries(orderId, 'sent');
      if (sent.length > 0) {
        return sent[0];
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for a sent delivery for order ${orderId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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
    await retailMicroservice.listen();

    catalogMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      CatalogMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          queue: MicroserviceQueueEnum.CATALOG_QUEUE,
          queueOptions: { durable: true },
        },
      },
    );
    await catalogMicroservice.listen();

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
    await inventoryMicroservice.listen();

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

    dataSource = new InventoryAutoInitE2ESpecDataSource({
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

    const login = await server()
      .post('/api/auth/customer/login')
      .send({ email: customerEmail, password: customerPassword });
    customerToken = (login.body as ITokenResponse).accessToken;

    variantId = await provisionVariant('a', 10);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await notificationMicroservice?.close();
    await dataSource?.destroy();
  });

  it('skips a marketing send for a customer who has not opted into marketing', async () => {
    // The fresh customer carries the defaults — marketingEmail is false — so the marketing
    // classification gates the send off. The RPC is request-response, so the row comes back
    // on the POST directly.
    const campaignId = `e2e-consent-gate-skip-${stamp}`;
    const { body } = await server()
      .post('/api/notifications/marketing/send')
      .set('Authorization', adminAuth)
      .send({ customerId, customerEmail, campaignId, context: { customerName: 'Buyer' } });

    const delivery = body as NotificationDeliveryView;
    expect(delivery.status).toBe('skipped-no-consent');
    // Terminal at creation — the NOTIFIER was never called (a sent row would have
    // attemptCount >= 1).
    expect(delivery.attemptCount).toBe(0);
    expect(delivery.recipientCustomerId).toBe(customerId);

    // Public audit query confirms exactly one row for the reference, and it never went sent.
    const rows = await server()
      .get('/api/notifications/deliveries')
      .query({ eventReferenceType: 'marketing', eventReferenceId: campaignId })
      .set('Authorization', adminAuth);
    const items = (rows.body as IPageBody<NotificationDeliveryView>).items;
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('skipped-no-consent');
  });

  it('still SENDS a transactional order confirmation to the same customer (bypass)', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    const cartId = (create.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: 1 });
    expect(add.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `consent-gate-place-${stamp}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    order = place.body as IOrderBody;

    // The transactional `retail.order.placed` bypasses the marketing gate: even with
    // marketingEmail off, the order confirmation is dispatched.
    const delivery = await waitForSentOrderDelivery(order.id);
    expect(delivery.status).toBe('sent');
    expect(delivery.channel).toBe('email');
    expect(delivery.recipientCustomerId).toBe(customerId);
    expect(delivery.recipientAddress).toBe(customerEmail);
    expect(delivery.renderedBody).toContain(order.orderNumber);
  });
});
