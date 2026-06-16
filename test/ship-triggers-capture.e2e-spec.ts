import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { InventoryAutoInitE2ESpecDataSource } from './data-source/inventory-auto-init.e2e-spec.data-source';

// Ship-triggered automatic capture (Q5 / ADR-031). Place authorizes the payment but
// does NOT take the money — the order leaves placement with `paymentStatus =
// authorized` and a `payment` row whose `capturedAt` is null. The FIRST ship of the
// order captures that authorized payment INLINE (the `block-ship-until-payment`
// posture: a decline would abort the ship), so after the ship the order's payment axis
// reads `captured` and the payment row's `capturedAt` is stamped — with no separate
// capture call.
//
// The `retail.payment.captured` emission is OBSERVED through the order's captured
// payment (the project convention: assert public state via the order GET, never an
// event spy). A second ship of a different fulfillment on the same order does NOT
// re-capture (the payment is already captured — the gateway is skipped), proving the
// capture is once-per-order, not once-per-ship.
//
// Self-provisioned, disjoint fixture (`e2e-ship-capture-*`): its own variant, so the
// shared seeded variants are never touched.
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

interface IPaymentBody {
  status: string;
  authorizedAt: string | null;
  capturedAt: string | null;
}

interface IOrderBody {
  id: number;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  lines: { id: number; variantId: number; quantity: number }[];
  payment?: IPaymentBody;
}

interface IFulfillmentBody {
  id: number;
  status: string;
}

describe('Ship triggers automatic payment capture (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let customerToken: string;

  let variantId: number;
  let cartId: string;
  let order: IOrderBody;
  let fulfillmentOneId: number;
  let fulfillmentTwoId: number;

  const ORDERED_QTY = 2;

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
        name: `E2E Ship Capture ${label} ${stamp}`,
        slug: `e2e-ship-capture-${label}-${stamp}`,
        description: 'ship-triggers-capture fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-SHIPCAP-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

  const getOrder = async (orderId: number): Promise<IOrderBody> => {
    const { body } = await server().get(`/api/orders/${orderId}`).set('Authorization', adminAuth);
    return body as IOrderBody;
  };

  const createFulfillment = async (quantity: number): Promise<number> => {
    const res = await server()
      .post(`/api/orders/${order.id}/fulfillments`)
      .set('Authorization', adminAuth)
      .send({ lines: [{ orderLineId: order.lines[0].id, quantity }] });
    expect(res.status).toBe(HttpStatus.CREATED);
    return (res.body as IFulfillmentBody).id;
  };

  const shipFulfillment = async (fulfillmentId: number, tracking: string): Promise<void> => {
    const res = await server()
      .post(`/api/orders/${order.id}/fulfillments/${fulfillmentId}/ship`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `ship-capture-${stamp}-${fulfillmentId}`)
      .send({ trackingNumber: tracking, carrier: 'UPS' });
    expect(res.status).toBe(HttpStatus.OK);
    expect((res.body as IFulfillmentBody).status).toBe('shipped');
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

    variantId = await provisionVariant('a', 5);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('place leaves the payment AUTHORIZED but not captured (capturedAt null)', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    cartId = (create.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: ORDERED_QTY });
    expect(add.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `ship-capture-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);

    order = place.body as IOrderBody;
    expect(order.paymentStatus).toBe('authorized');
    expect(order.payment?.status).toBe('authorized');
    expect(order.payment?.authorizedAt).not.toBeNull();
    // The money is NOT yet taken — capture happens at ship time.
    expect(order.payment?.capturedAt).toBeNull();
  });

  it('shipping the first (partial) fulfillment captures the payment automatically', async () => {
    // A partial fulfillment (1 of 2 ordered) so a second ship can prove no re-capture.
    fulfillmentOneId = await createFulfillment(1);

    // Still authorized right before the ship.
    expect((await getOrder(order.id)).paymentStatus).toBe('authorized');

    await shipFulfillment(fulfillmentOneId, '1Z999AA10123456101');

    // The ship-triggered capture flipped the payment axis to `captured` — observed via
    // the order's payment, not an event spy.
    const fresh = await getOrder(order.id);
    expect(fresh.paymentStatus).toBe('captured');
    expect(fresh.payment?.status).toBe('captured');
    expect(fresh.payment?.capturedAt).not.toBeNull();
    // Lifecycle stays `pending`; the order is only partially shipped.
    expect(fresh.status).toBe('pending');
    expect(fresh.fulfillmentStatus).toBe('partially-shipped');
  });

  it('shipping the second fulfillment does NOT re-capture (payment already captured)', async () => {
    const before = await getOrder(order.id);
    const capturedAtAfterFirstShip = before.payment?.capturedAt;

    fulfillmentTwoId = await createFulfillment(1);
    await shipFulfillment(fulfillmentTwoId, '1Z999AA10123456102');

    const fresh = await getOrder(order.id);
    expect(fresh.paymentStatus).toBe('captured');
    expect(fresh.fulfillmentStatus).toBe('shipped');
    // The capture timestamp is unchanged — the second ship skipped the gateway because
    // the payment was already captured (once-per-order, not once-per-ship).
    expect(fresh.payment?.capturedAt).toBe(capturedAtAfterFirstShip);
  });
});
