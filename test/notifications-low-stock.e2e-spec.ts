import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as NotificationMicroserviceAppModule } from '@retail-inventory-system/apps/notification-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import {
  INotificationDeliveryRowProjection,
  NotificationDeliveryE2ESpecDataSource,
} from './data-source/notification-delivery.e2e-spec.data-source';

// A low-stock adjustment fans out a SYSTEM/OPS notification (ADR-033). Staff drive a
// self-provisioned variant's on-hand below the low-stock threshold; the inventory
// microservice emits `inventory.stock.low` onto `notification_events`; the notification
// microservice's `InventoryEventsConsumer` routes it through `RenderAndDispatchUseCase`,
// which resolves the seeded `inventory.stock.low` template and dispatches to the operations
// mailbox.
//
// Unlike a buyer notification, this one has NO customer — it is asserted (via a direct
// `notification_delivery` row read) to go to `OPS_NOTIFICATIONS_EMAIL` with a NULL
// `recipient_customer_id` (the system-row shape; not deduped, ADR-033). No retail
// microservice is needed — provisioning + the adjustment + the alert exercise only
// catalog → inventory → notification.
//
// Self-provisioned, disjoint fixture (`e2e-notif-lowstock-*`).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';
// Joi default (`.env.local` does not override it) — the ops mailbox the alert is sent to.
const OPS_EMAIL = 'ops@example.com';
// The seeded `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`; on-hand at or below it fires the alert.
const RECEIVE_QTY = 6;
const ADJUST_DELTA = -3; // 6 - 3 = 3, at or below the threshold (5) → low-stock fires.
const EXPECTED_ON_HAND = RECEIVE_QTY + ADJUST_DELTA;

interface ITokenResponse {
  accessToken: string;
}

describe('Notifications — low-stock adjustment fans out to ops (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let notificationMicroservice: INestMicroservice;
  let dataSource: NotificationDeliveryE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let variantId: number;

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
        name: `E2E Notif LowStock ${label} ${stamp}`,
        slug: `e2e-notif-lowstock-${label}-${stamp}`,
        description: 'notification low-stock fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-NOTIFLOW-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

  const waitForSentLowStockDelivery = async (
    variant: number,
    deadlineMs = 20_000,
  ): Promise<INotificationDeliveryRowProjection> => {
    const eventReferenceId = `${variant}:${DEFAULT_WAREHOUSE}`;
    const start = Date.now();
    for (;;) {
      const rows = await dataSource.getDeliveriesByEventRef('stock-low', eventReferenceId);
      const sent = rows.find((row) => row.status === 'sent');
      if (sent) {
        return sent;
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for a sent low-stock delivery for variant ${variant}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

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

    dataSource = new NotificationDeliveryE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

    variantId = await provisionVariant('a', RECEIVE_QTY);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await notificationMicroservice?.close();
    await dataSource?.destroy();
  });

  it('adjusts on-hand below the low-stock threshold', async () => {
    const adjust = await server()
      .post(`/api/inventory/variants/${variantId}/stock/adjust`)
      .set('Authorization', adminAuth)
      .send({ quantityDelta: ADJUST_DELTA, reasonCode: 'shrinkage' });
    expect(adjust.status).toBe(HttpStatus.OK);
    expect((adjust.body as { quantityOnHand: number }).quantityOnHand).toBe(EXPECTED_ON_HAND);
  });

  it('fans out a sent system delivery to the ops mailbox with no customer', async () => {
    const delivery = await waitForSentLowStockDelivery(variantId);

    expect(delivery.status).toBe('sent');
    expect(delivery.channel).toBe('email');
    expect(delivery.eventReferenceType).toBe('stock-low');
    expect(delivery.eventReferenceId).toBe(`${variantId}:${DEFAULT_WAREHOUSE}`);
    // A system/ops alert: it goes to the ops mailbox and has no customer recipient.
    expect(delivery.recipientAddress).toBe(OPS_EMAIL);
    expect(delivery.recipientCustomerId).toBeNull();
    // Rendered from the `inventory.stock.low` template against the event.
    expect(delivery.renderedBody).toContain(String(variantId));
    expect(delivery.renderedBody).toContain(String(EXPECTED_ON_HAND));
  });
});
