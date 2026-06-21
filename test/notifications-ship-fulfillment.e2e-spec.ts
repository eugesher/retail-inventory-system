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

// Shipping a fulfillment yields a shipment-confirmation email (ADR-033). A customer places
// an order; staff create + ship a fulfillment; the retail microservice emits
// `retail.fulfillment.shipped` (carrying the carrier metadata + the buyer's resolved
// `customerEmail`) onto `notification_events`; the notification microservice's
// `FulfillmentEventsConsumer` routes it through `RenderAndDispatchUseCase`, which resolves
// the seeded `retail.fulfillment.shipped` template and renders the tracking number into the
// body.
//
// Asserted through PUBLIC STATE — the gateway delivery audit query filtered to this
// shipment's reference (`fulfillment` / `fulfillmentId`) — never an event spy. The shipped
// wire event carries no `customerId`, so `recipientCustomerId` is null (not deduped, ADR-033);
// the recipient is the buyer's email and the `renderedBody` carries the tracking number,
// proving the template resolved and rendered against the event.
//
// Self-provisioned, disjoint fixture (`e2e-notif-ship-*`).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const TRACKING_NUMBER = '1ZNOTIF999SHIP0001';
const CARRIER = 'UPS';

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
  lines: { id: number; variantId: number; quantity: number }[];
}

interface IFulfillmentBody {
  id: number;
  status: string;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Notifications — ship fulfillment yields a shipment email (e2e)', () => {
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
  let fulfillmentId: number;

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
        name: `E2E Notif Ship ${label} ${stamp}`,
        slug: `e2e-notif-ship-${label}-${stamp}`,
        description: 'notification ship fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({
        sku: `E2E-NOTIFSHIP-${label}-${stamp}`,
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

  const waitForSentDelivery = async (
    fulfillment: number,
    deadlineMs = 20_000,
  ): Promise<NotificationDeliveryView> => {
    const start = Date.now();
    for (;;) {
      const { body } = await server()
        .get('/api/notifications/deliveries')
        .query({
          eventReferenceType: 'fulfillment',
          eventReferenceId: String(fulfillment),
          status: 'sent',
        })
        .set('Authorization', adminAuth);
      const items = (body as IPageBody<NotificationDeliveryView>).items;
      if (items.length > 0) {
        return items[0];
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for a sent delivery for fulfillment ${fulfillment}`);
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

  it('places an order and ships a fulfillment for it', async () => {
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
      .set('Idempotency-Key', `notif-ship-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    order = place.body as IOrderBody;

    const fulfillmentRes = await server()
      .post(`/api/orders/${order.id}/fulfillments`)
      .set('Authorization', adminAuth)
      .send({ lines: [{ orderLineId: order.lines[0].id, quantity: 2 }] });
    expect(fulfillmentRes.status).toBe(HttpStatus.CREATED);
    fulfillmentId = (fulfillmentRes.body as IFulfillmentBody).id;

    const shipRes = await server()
      .post(`/api/orders/${order.id}/fulfillments/${fulfillmentId}/ship`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `notif-ship-${stamp}-ship`)
      .send({ trackingNumber: TRACKING_NUMBER, carrier: CARRIER });
    expect(shipRes.status).toBe(HttpStatus.OK);
    expect((shipRes.body as IFulfillmentBody).status).toBe('shipped');
  });

  it('produces a sent shipment delivery whose body carries the tracking number', async () => {
    const delivery = await waitForSentDelivery(fulfillmentId);

    expect(delivery.status).toBe('sent');
    expect(delivery.channel).toBe('email');
    expect(delivery.eventReferenceType).toBe('fulfillment');
    expect(delivery.eventReferenceId).toBe(String(fulfillmentId));
    expect(delivery.recipientAddress).toBe(CUSTOMER_EMAIL);
    // The shipped event carries no customer id, so the row is a non-deduped system-keyed row.
    expect(delivery.recipientCustomerId).toBeNull();
    // Rendered from the `retail.fulfillment.shipped` template against the event.
    expect(delivery.renderedBody).toContain(TRACKING_NUMBER);
    expect(delivery.renderedBody).toContain(CARRIER);
  });
});
