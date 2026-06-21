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

// Placing an order yields exactly one customer email notification (ADR-033). A customer
// places a real order through the gateway; the retail microservice emits
// `retail.order.placed` (carrying the buyer's resolved `customerEmail`) onto
// `notification_events`; the notification microservice's `OrderEventsConsumer` routes it
// through `RenderAndDispatchUseCase`, which resolves the seeded `retail.order.placed`
// template, renders it against the event, persists a `queued` delivery, then dispatches and
// flips it to `sent`.
//
// Everything is asserted through PUBLIC STATE — the gateway delivery audit query
// (`GET /api/notifications/deliveries`, staff `notifications:read`) — never an event spy.
// The query is filtered to this order's reference so the assertion is robust against the
// other suites' deliveries sharing the same trail. Exactly one `sent` row appears (the
// dedupe guard collapses any redelivery on the customer-id-anchored key), its recipient is
// the seeded customer's email, and its `renderedBody` carries the order number — proving the
// template was resolved and rendered, not a hard-coded string.
//
// Self-provisioned, disjoint fixture (`e2e-notif-place-*`): its own variant, so the shared
// seeded variants are never touched.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
// The seeded customer's id (the JS identity seed pass) — the delivery's
// `recipient_customer_id` and the dedupe anchor.
const CUSTOMER_ID = '00000000-0000-4000-a000-000000000002';

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

describe('Notifications — place order yields one sent delivery (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let notificationMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let customerToken: string;

  let variantId: number;
  let cartId: string;
  let order: IOrderBody;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const customerLogin = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/customer/login').send({ email, password });
    return (body as ITokenResponse).accessToken;
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
        name: `E2E Notif Place ${label} ${stamp}`,
        slug: `e2e-notif-place-${label}-${stamp}`,
        description: 'notification place-order fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({
        sku: `E2E-NOTIFPLACE-${label}-${stamp}`,
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
    const req = server()
      .get('/api/notifications/deliveries')
      .query({
        eventReferenceType: 'order',
        eventReferenceId: String(orderId),
        ...(status && { status }),
      })
      .set('Authorization', adminAuth);
    const { body } = await req;
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
    customerToken = await customerLogin(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

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

  it('places an order through the gateway', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    cartId = (create.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: 2 });
    expect(add.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `notif-place-${stamp}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);

    order = place.body as IOrderBody;
    expect(order.status).toBe('pending');
    expect(order.orderNumber).toBeTruthy();
  });

  it('produces exactly one sent delivery to the customer, rendered from the seeded template', async () => {
    const delivery = await waitForSentOrderDelivery(order.id);

    expect(delivery.status).toBe('sent');
    expect(delivery.channel).toBe('email');
    expect(delivery.eventReferenceType).toBe('order');
    expect(delivery.eventReferenceId).toBe(String(order.id));
    // Recipient is the buyer's resolved email; the customer id is the dedupe anchor.
    expect(delivery.recipientAddress).toBe(CUSTOMER_EMAIL);
    expect(delivery.recipientCustomerId).toBe(CUSTOMER_ID);
    // The body was rendered from the `retail.order.placed` template against the event —
    // it carries the order number.
    expect(delivery.renderedBody).toContain(order.orderNumber);
    expect(delivery.renderedSubject).toContain(order.orderNumber);
  });

  it('does not write a second sent row for the same order (dedupe)', async () => {
    // Exactly one row exists for this order reference across ALL statuses — the
    // customer-id-anchored dedupe key collapses any at-least-once redelivery to a no-op.
    const all = await listOrderDeliveries(order.id);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('sent');
  });
});
