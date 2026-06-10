import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

// The retail orders event publisher (the `ORDER_EVENTS_PUBLISHER` binding via
// `useExisting`, so spying the class instance observes the use case's emits). Tests
// may reach into app internals — the boundaries lint is off for `test/**`.
import { OrderRabbitmqPublisher } from '../apps/retail-microservice/src/modules/orders/infrastructure/messaging';

// Seeded fixtures (scripts/test-db-seed.ts + scripts/seeds/*.sql).
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

// Variant 1 — "Aurora Desk Lamp", SKU AURORA-WARM, USD 4999. Variant 3 — "Nimbus
// Office Chair", SKU NIMBUS-BLACK, USD 19999.
const VARIANT_ONE = { id: 1, sku: 'AURORA-WARM', name: 'Aurora Desk Lamp', priceMinor: 4999 };
const VARIANT_TWO = { id: 3, sku: 'NIMBUS-BLACK', name: 'Nimbus Office Chair', priceMinor: 19999 };
const GRAND_TOTAL = VARIANT_ONE.priceMinor * 2 + VARIANT_TWO.priceMinor; // 29997

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

interface IOrderLineBody {
  id: number;
  variantId: number;
  sku: string;
  nameSnapshot: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

interface IPaymentBody {
  id: number;
  amountMinor: number;
  status: string;
  gatewayReference: string;
}

interface IOrderBody {
  id: number;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  currency: string;
  subtotalMinor: number;
  grandTotalMinor: number;
  billingAddressId: string | null;
  shippingAddressId: string | null;
  lines: IOrderLineBody[];
  payment?: IPaymentBody;
}

describe('Cart → Order walking skeleton (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;

  let orderPlacedSpy: jest.SpyInstance;
  let paymentAuthorizedSpy: jest.SpyInstance;
  let paymentCapturedSpy: jest.SpyInstance;

  const login = async (): Promise<string> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    return (body as ITokenResponse).accessToken;
  };

  const addLine = async (
    accessToken: string,
    cartId: string,
    variantId: number,
    quantity: number,
  ): Promise<void> => {
    await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ variantId, quantity });
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

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    // Spy on the retail-side event publisher (calls through to the real broker emit)
    // so the test can assert both wire events fired on a successful place.
    const publisher = retailMicroservice.get(OrderRabbitmqPublisher, { strict: false });
    orderPlacedSpy = jest.spyOn(publisher, 'publishOrderPlaced');
    paymentAuthorizedSpy = jest.spyOn(publisher, 'publishPaymentAuthorized');
    paymentCapturedSpy = jest.spyOn(publisher, 'publishPaymentCaptured');
  }, timeout);

  afterAll(async () => {
    orderPlacedSpy?.mockRestore();
    paymentAuthorizedSpy?.mockRestore();
    paymentCapturedSpy?.mockRestore();
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
  });

  describe('place an order from a two-line cart', () => {
    let accessToken: string;
    let cartId: string;
    let placed: IOrderBody;

    it('logs in, builds a two-line cart, and places it', async () => {
      accessToken = await login();

      const create = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/cart')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currency: 'USD' });
      cartId = (create.body as { id: string }).id;

      await addLine(accessToken, cartId, VARIANT_ONE.id, 2);
      await addLine(accessToken, cartId, VARIANT_TWO.id, 1);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/cart/${cartId}/place`)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', '4b1f8a2e-0001-4a00-8a00-000000000001')
        .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });

      expect(status).toBe(HttpStatus.CREATED);
      placed = body as IOrderBody;
    });

    it('returns a pending order with an authorized payment and the three orthogonal axes', () => {
      expect(placed.orderNumber).toMatch(/^ORD-\d{4}-\d{8}$/);
      expect(placed.status).toBe('pending');
      expect(placed.paymentStatus).toBe('authorized');
      expect(placed.fulfillmentStatus).toBe('unfulfilled');
      expect(placed.currency).toBe('USD');
      expect(placed.grandTotalMinor).toBe(GRAND_TOTAL);
      expect(placed.subtotalMinor).toBe(GRAND_TOTAL);
      expect(placed.billingAddressId).toEqual(expect.any(String));
      expect(placed.shippingAddressId).toEqual(expect.any(String));
      expect(placed.billingAddressId).not.toBe(placed.shippingAddressId);
    });

    it('snapshots each line sku / nameSnapshot / unitPriceMinor from the catalog', () => {
      expect(placed.lines).toHaveLength(2);
      const byVariant = new Map(placed.lines.map((line) => [line.variantId, line]));

      const lineOne = byVariant.get(VARIANT_ONE.id)!;
      expect(lineOne.sku).toBe(VARIANT_ONE.sku);
      expect(lineOne.nameSnapshot).toContain(VARIANT_ONE.name);
      expect(lineOne.unitPriceMinor).toBe(VARIANT_ONE.priceMinor);
      expect(lineOne.quantity).toBe(2);
      expect(lineOne.lineTotalMinor).toBe(VARIANT_ONE.priceMinor * 2);

      const lineTwo = byVariant.get(VARIANT_TWO.id)!;
      expect(lineTwo.sku).toBe(VARIANT_TWO.sku);
      expect(lineTwo.nameSnapshot).toContain(VARIANT_TWO.name);
      expect(lineTwo.unitPriceMinor).toBe(VARIANT_TWO.priceMinor);
    });

    it('carries the authorized payment on the order view', () => {
      expect(placed.payment).toBeDefined();
      expect(placed.payment?.status).toBe('authorized');
      expect(placed.payment?.amountMinor).toBe(GRAND_TOTAL);
      expect(placed.payment?.gatewayReference).toMatch(/^fake_/);
    });

    it('published retail.order.placed and retail.payment.authorized', () => {
      expect(orderPlacedSpy).toHaveBeenCalled();
      expect(paymentAuthorizedSpy).toHaveBeenCalled();
    });

    // Step 6 — read the placed order back through the gateway orders module and assert
    // the populated place-time snapshots survive the round trip.
    it('GET /api/orders/:orderId returns the populated line snapshots (owner read)', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get(`/api/orders/${placed.id}`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(status).toBe(HttpStatus.OK);
      const fetched = body as IOrderBody;
      expect(fetched.id).toBe(placed.id);
      expect(fetched.orderNumber).toBe(placed.orderNumber);
      expect(fetched.lines).toHaveLength(2);

      const lineOne = fetched.lines.find((line) => line.variantId === VARIANT_ONE.id)!;
      expect(lineOne.sku).toBe(VARIANT_ONE.sku);
      expect(lineOne.nameSnapshot).toContain(VARIANT_ONE.name);
      expect(lineOne.unitPriceMinor).toBe(VARIANT_ONE.priceMinor);
      expect(fetched.payment?.status).toBe('authorized');
    });

    // Step 7 — the owning customer captures its own payment. Payment + order payment
    // axis both advance to `captured`, and `retail.payment.captured` is published.
    it('POST /api/orders/:orderId/payments/capture captures (owner) and publishes the event', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/orders/${placed.id}/payments/capture`)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', '4b1f8a2e-0003-4a00-8a00-000000000003')
        .send({});

      expect(status).toBe(HttpStatus.OK);
      const captured = body as IOrderBody;
      expect(captured.paymentStatus).toBe('captured');
      expect(captured.payment?.status).toBe('captured');
      expect(captured.payment?.id).toBe(placed.payment?.id);
      expect(paymentCapturedSpy).toHaveBeenCalled();
    });

    // Step 8 — re-placing the now-converted cart returns the SAME order + payment.
    // Repeat-safety is cart-state-driven (the cart is `converted`), not header dedupe:
    // a brand-new Idempotency-Key still resolves to the existing order. Key-based
    // dedupe is a later capability.
    it('is repeat-safe: re-placing the now-converted cart returns the same order + payment', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/cart/${cartId}/place`)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', '4b1f8a2e-0002-4a00-8a00-000000000002')
        .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });

      expect(status).toBe(HttpStatus.CREATED);
      const repeat = body as IOrderBody;
      expect(repeat.id).toBe(placed.id);
      expect(repeat.orderNumber).toBe(placed.orderNumber);
      expect(repeat.payment?.id).toBe(placed.payment?.id);
    });
  });
});
