import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum, PaymentStatusEnum } from '@retail-inventory-system/contracts';

import { PAYMENT_GATEWAY } from '../apps/retail-microservice/src/modules/orders/application/ports';
import type { IPaymentGatewayPort } from '../apps/retail-microservice/src/modules/orders/application/ports';
import { CaptureClaimE2ESpecDataSource } from './data-source/capture-claim.e2e-spec.data-source';

// THE proof for ISSUE-05 + ISSUE-07 (ADR-052): **one authorization is charged at most once, even when
// two callers race to charge it.**
//
// Two code paths call `paymentGateway.capture(payment.gatewayReference)` — the explicit
// `POST /payments/capture` and the ship-triggered capture inside `POST /fulfillments/:id/ship`. Both
// used to check `payment.status === AUTHORIZED` on an **unlocked** read and then charge. Two of them
// could pass that check at the same instant, both charge the processor, and the loser would throw
// `PAYMENT_INVALID_STATUS_TRANSITION` and roll its transaction back — reporting correct STATE while
// the money had moved twice. **A rollback cannot un-call a payment gateway.**
//
// **The bound `FakePaymentGatewayAdapter` always approves and never moves money, so NO ASSERTION ON
// AN OUTCOME CAN SEE AN OVERCHARGE.** The database would look perfect either way: one `captured`
// payment, one clean 409. That is precisely why this defect survived a green test suite. So the spec
// spies on the port and **counts the calls** — the only observable that distinguishes "charged once"
// from "charged twice and tidied up afterwards".
//
// Against the parent commit the first scenario records **two** calls. That is the whole finding.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';

const ADDRESS = {
  recipientName: 'Double Charge',
  line1: '1 Market St',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94105',
  country: 'US',
};

interface ITokenResponse {
  accessToken: string;
}

interface IOutcome {
  label: string;
  status: number;
  body: Record<string, unknown>;
}

describe('Concurrent capture — one authorization is charged at most once (e2e)', () => {
  const timeout = 120_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: CaptureClaimE2ESpecDataSource;

  let captureSpy: jest.SpyInstance;

  const stamp = Date.now();
  let adminAuth: string;
  let customerToken: string;
  let variantId: number;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const customerLogin = async (): Promise<string> => {
    const { body } = await server()
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    return (body as ITokenResponse).accessToken;
  };

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const waitForStockRow = async (variant: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelCount(variant)) === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for the auto-init stock_level row for ${variant}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const provisionVariant = async (onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Double Charge ${stamp}`,
        slug: `e2e-double-charge-${stamp}`,
        description: 'ADR-052 fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-DBLCHG-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variant = (variantRes.body as { id: number }).id;

    await server()
      .post(`/api/catalog/variants/${variant}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });

    await settleTimestampRounding();
    await server()
      .post(`/api/catalog/products/${productId}/publish`)
      .set('Authorization', adminAuth);

    await waitForStockRow(variant);

    await server()
      .post(`/api/inventory/variants/${variant}/stock/receive`)
      .set('Authorization', adminAuth)
      .send({ quantity: onHand });

    return variant;
  };

  // A placed order, authorized-on-place: `payment.status = 'authorized'`, nothing captured yet.
  const placeOrder = async (label: string): Promise<number> => {
    const cartRes = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    const cartId = (cartRes.body as { id: string }).id;

    await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: 1 });

    const placeRes = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `dblchg-place-${label}-${stamp}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(placeRes.status).toBe(HttpStatus.CREATED);
    return (placeRes.body as { id: number }).id;
  };

  const createFulfillment = async (orderId: number): Promise<number> => {
    const { body: order } = await server()
      .get(`/api/orders/${orderId}`)
      .set('Authorization', adminAuth);
    const lines = (order as { lines: { id: number; quantity: number }[] }).lines;

    const res = await server()
      .post(`/api/orders/${orderId}/fulfillments`)
      .set('Authorization', adminAuth)
      .send({
        stockLocationId: DEFAULT_WAREHOUSE,
        lines: lines.map((l) => ({ orderLineId: l.id, quantity: l.quantity })),
      });
    expect(res.status).toBe(HttpStatus.CREATED);
    return (res.body as { id: number }).id;
  };

  // Fire a request and capture its outcome WITHOUT throwing on a non-2xx — the loser's 409 is an
  // expected result here, not an error.
  const fire = async (label: string, request: supertest.Test): Promise<IOutcome> => {
    const res = await request;
    return { label, status: res.status, body: res.body as Record<string, unknown> };
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

    // **The instrument.** The bound gateway never moves money, so the call COUNT is the only thing
    // that can tell a single charge from a double one. Spy, do not stub: the real adapter still runs.
    const gateway = retailMicroservice.get<IPaymentGatewayPort>(PAYMENT_GATEWAY, { strict: false });
    captureSpy = jest.spyOn(gateway, 'capture');

    dataSource = new CaptureClaimE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);
    customerToken = await customerLogin();
    variantId = await provisionVariant(20);
  }, timeout);

  afterAll(async () => {
    captureSpy?.mockRestore();
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  beforeEach(() => captureSpy.mockClear());

  // ═══ THE TEST THE WHOLE TASK EXISTS FOR ═══
  it(
    'a ship and an explicit capture, in flight at once, charge the gateway EXACTLY ONCE',
    async () => {
      const orderId = await placeOrder('race');
      const fulfillmentId = await createFulfillment(orderId);

      // Both in flight. Both used to pass an unlocked `AUTHORIZED` check and reach the processor.
      const outcomes = await Promise.all([
        fire(
          'capture',
          server()
            .post(`/api/orders/${orderId}/payments/capture`)
            .set('Authorization', adminAuth)
            .set('Idempotency-Key', `dblchg-cap-${stamp}`)
            .send({}),
        ),
        fire(
          'ship',
          server()
            .post(`/api/orders/${orderId}/fulfillments/${fulfillmentId}/ship`)
            .set('Authorization', adminAuth)
            .set('Idempotency-Key', `dblchg-ship-${stamp}`)
            .send({ trackingNumber: `TRK-${stamp}`, carrier: 'ups' }),
        ),
      ]);

      // **The assertion.** One authorization, one charge. On the parent commit this is 2.
      expect(captureSpy).toHaveBeenCalledTimes(1);

      // Winner-agnostic: exactly one may fail, and if one did it must be a clean 409 — a refusal
      // raised BEFORE the gateway, not a 500 and not a rollback after the money moved.
      const failures = outcomes.filter((o) => o.status >= 400);
      expect(failures.length).toBeLessThanOrEqual(1);
      for (const failure of failures) {
        expect(failure.status).toBe(HttpStatus.CONFLICT as number);
      }

      // The money is recorded exactly once, and the claim is resolved — no row left `capturing`.
      const payment = await dataSource.getPayment(orderId);
      expect(payment?.status).toBe(PaymentStatusEnum.CAPTURED);
    },
    timeout,
  );

  // ISSUE-05's second victim: a cancel that lands mid-capture used to void an authorization whose
  // money was already gone — customer charged, order cancelled, row reading `voided`, and nothing in
  // the system aware there was anything to reconcile.
  it(
    'a cancel racing a ship never leaves money captured against a cancelled order',
    async () => {
      const orderId = await placeOrder('cancel');
      const fulfillmentId = await createFulfillment(orderId);

      const outcomes = await Promise.all([
        fire(
          'ship',
          server()
            .post(`/api/orders/${orderId}/fulfillments/${fulfillmentId}/ship`)
            .set('Authorization', adminAuth)
            .set('Idempotency-Key', `dblchg-cancelrace-ship-${stamp}`)
            .send({ trackingNumber: `TRK-C-${stamp}`, carrier: 'ups' }),
        ),
        fire(
          'cancel',
          server()
            .post(`/api/orders/${orderId}/cancel`)
            .set('Authorization', adminAuth)
            .send({ reason: 'racing the ship' }),
        ),
      ]);

      const shipped = outcomes.find((o) => o.label === 'ship')!.status < 400;
      const cancelled = outcomes.find((o) => o.label === 'cancel')!.status < 400;

      // They cannot both win: one of the two must be refused.
      expect(shipped && cancelled).toBe(false);

      const payment = await dataSource.getPayment(orderId);
      if (shipped) {
        // The ship won: the money moved exactly once and the cancel was refused.
        expect(captureSpy).toHaveBeenCalledTimes(1);
        expect(payment?.status).toBe(PaymentStatusEnum.CAPTURED);
      } else {
        // The cancel won — then the gateway must NEVER have been called. **This is the impossible state
        // made impossible:** money captured against an order that is cancelled and unshipped.
        expect(captureSpy).not.toHaveBeenCalled();
        expect(payment?.status).toBe(PaymentStatusEnum.VOIDED);
      }
      // Either way, no claim is left dangling.
      expect(payment?.status).not.toBe(PaymentStatusEnum.CAPTURING);
    },
    timeout,
  );

  it(
    'a sequential second capture is idempotent and does not re-charge',
    async () => {
      const orderId = await placeOrder('idem');

      const first = await server()
        .post(`/api/orders/${orderId}/payments/capture`)
        .set('Authorization', adminAuth)
        .set('Idempotency-Key', `dblchg-idem-a-${stamp}`)
        .send({});
      expect(first.status).toBe(HttpStatus.OK);
      expect(captureSpy).toHaveBeenCalledTimes(1);

      // A FRESH idempotency key, so the request-level replay guard does not fire — this is the natural
      // payment-state idempotency, and it must not reach the gateway either.
      const second = await server()
        .post(`/api/orders/${orderId}/payments/capture`)
        .set('Authorization', adminAuth)
        .set('Idempotency-Key', `dblchg-idem-b-${stamp}`)
        .send({});
      expect(second.status).toBe(HttpStatus.OK);
      expect(captureSpy).toHaveBeenCalledTimes(1);
    },
    timeout,
  );

  // ISSUE-09, on the same route: `amountMinor` used to be accepted and silently ignored — a client
  // asking to capture 10.00 was charged the full total and got a 200 that contradicted nothing.
  it(
    'rejects a capture amount that is not the grand total, and does NOT charge',
    async () => {
      const orderId = await placeOrder('partial');

      const res = await server()
        .post(`/api/orders/${orderId}/payments/capture`)
        .set('Authorization', adminAuth)
        .set('Idempotency-Key', `dblchg-partial-${stamp}`)
        .send({ amountMinor: 1 });

      expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect((res.body as { code: string }).code).toBe('PARTIAL_CAPTURE_UNSUPPORTED');
      // The rejection happens before any money moves — that is the point of it.
      expect(captureSpy).not.toHaveBeenCalled();

      const payment = await dataSource.getPayment(orderId);
      expect(payment?.status).toBe(PaymentStatusEnum.AUTHORIZED);
    },
    timeout,
  );

  it(
    'accepts a capture amount that EQUALS the grand total',
    async () => {
      const orderId = await placeOrder('exact');
      const { body: order } = await server()
        .get(`/api/orders/${orderId}`)
        .set('Authorization', adminAuth);

      const res = await server()
        .post(`/api/orders/${orderId}/payments/capture`)
        .set('Authorization', adminAuth)
        .set('Idempotency-Key', `dblchg-exact-${stamp}`)
        .send({ amountMinor: (order as { grandTotalMinor: number }).grandTotalMinor });

      expect(res.status).toBe(HttpStatus.OK);
      expect(captureSpy).toHaveBeenCalledTimes(1);
    },
    timeout,
  );
});
