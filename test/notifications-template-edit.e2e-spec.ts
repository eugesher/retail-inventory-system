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
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';

import { InventoryAutoInitE2ESpecDataSource } from './data-source/inventory-auto-init.e2e-spec.data-source';

// Authoring a new template version takes effect on the next event (ADR-033 — newest active
// version wins). Staff author a v2 of the `retail.order.placed` template over the gateway
// (`POST /api/notifications/templates`, `notifications:write`) with a body carrying a unique
// marker; then a customer places an order; the resulting delivery's `renderedBody` reflects
// the v2 body, not the seeded v1 — proving the version-bump-and-resolve path end to end.
//
// The v2 body deliberately KEEPS `{{orderNumber}}` (a superset of the seeded body), so the
// place-order suite's "body contains the order number" assertion still holds regardless of
// which suite runs first (e2e runs in-band/serial, but the body stays compatible either way).
//
// Asserted through PUBLIC STATE — the gateway delivery audit query filtered to this order's
// reference — never an event spy. Self-provisioned, disjoint fixture (`e2e-notif-edit-*`).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

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
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Notifications — template edit takes effect on the next order (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let notificationMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  // A per-run marker that only the v2 body carries — proof the new version rendered.
  const V2_MARKER = `V2-EDIT-${stamp}`;
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
        name: `E2E Notif Edit ${label} ${stamp}`,
        slug: `e2e-notif-edit-${label}-${stamp}`,
        description: 'notification template-edit fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({
        sku: `E2E-NOTIFEDIT-${label}-${stamp}`,
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

  const waitForSentOrderDelivery = async (
    orderId: number,
    deadlineMs = 20_000,
  ): Promise<NotificationDeliveryView> => {
    const start = Date.now();
    for (;;) {
      const { body } = await server()
        .get('/api/notifications/deliveries')
        .query({ eventReferenceType: 'order', eventReferenceId: String(orderId), status: 'sent' })
        .set('Authorization', adminAuth);
      const items = (body as IPageBody<NotificationDeliveryView>).items;
      if (items.length > 0) {
        return items[0];
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

  it('authors a new active version of the order-placed template over the gateway', async () => {
    const res = await server()
      .post('/api/notifications/templates')
      .set('Authorization', adminAuth)
      .send({
        eventType: 'retail.order.placed',
        channel: 'email',
        locale: 'en-US',
        subject: 'Order #{{orderNumber}} confirmed (v2)',
        body: `${V2_MARKER} — order #{{orderNumber}} confirmed.`,
      });
    expect(res.status).toBe(HttpStatus.CREATED);
    const template = res.body as NotificationTemplateView;
    // A fresh version appended on top of the seeded v1 (newest active wins).
    expect(template.version).toBeGreaterThanOrEqual(2);
    expect(template.active).toBe(true);
  });

  it('renders the new version into the next order placed', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    cartId = (create.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: 1 });
    expect(add.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `notif-edit-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    order = place.body as IOrderBody;

    const delivery = await waitForSentOrderDelivery(order.id);

    // The body reflects the v2 marker — not the seeded v1 body — and still carries the
    // order number (the superset that keeps the place-order suite robust).
    expect(delivery.renderedBody).toContain(V2_MARKER);
    expect(delivery.renderedBody).toContain(order.orderNumber);
    expect(delivery.renderedSubject).toContain('(v2)');
  });
});
