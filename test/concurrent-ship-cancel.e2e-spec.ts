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

// Concurrent ship-vs-cancel race on the SAME order (ADR-031). A Ship and a Cancel
// hit one order at the same instant (both requests fired without awaiting the first).
// EXACTLY ONE wins, and the loser does not invert state:
//   - if Ship wins → the order is shipped-ward (fulfillment `shipped`, order not
//     cancelled, payment captured) and the Cancel is `409 ORDER_NOT_CANCELLABLE`
//     (a shipped fulfillment now exists);
//   - if Cancel wins → the order is `cancelled` (payment voided, fulfillment
//     `cancelled`) and the Ship is a 4xx (the fulfillment is no longer shippable —
//     `409 FULFILLMENT_INVALID_STATUS_TRANSITION`).
//
// The guard is the Fulfillment/Order status preconditions re-checked INSIDE each use
// case's transaction under a pessimistic write lock on the contended `fulfillment`
// row: the two transitions serialise on that row, so the loser blocks until the
// winner commits and then observes the committed status, which its precondition
// rejects. This single-writer-per-status-transition guard is what the suite proves;
// strict optimistic-concurrency on `order.version` (a per-aggregate compare-and-swap
// across every order write) is a later capability and is not what serialises this
// race today.
//
// Winner-AGNOSTIC: the suite never assumes WHICH side wins — it classifies each race
// by outcome and asserts the corresponding consistent end-state. It asserts DB-backed
// PUBLIC state (the order GET + the fulfillment list), never a broker side effect or
// an event spy, and never sleeps to "let things settle". Several independent races run
// per invocation (each on a fresh order), and the whole suite must stay green across 5
// consecutive runs.
//
// Self-provisioned, disjoint fixture (`e2e-ship-cancel-race-*`): its own variant with
// ample stock, so the shared seeded variants are never touched and the per-race orders
// never contend on inventory (the contention under test is the order/fulfillment
// status transition, not stock).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

const RACE_COUNT = 6;

const ADDRESS = {
  recipientName: 'Race Both',
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
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  lines: { id: number; variantId: number; quantity: number }[];
  payment?: { status: string };
}

interface IFulfillmentBody {
  id: number;
  status: string;
}

interface IRaceOutcome {
  status: number;
  body: Record<string, unknown>;
}

describe('Concurrent ship vs cancel on the same order (e2e)', () => {
  const timeout = 120_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let customerToken: string;
  let variantId: number;

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
        name: `E2E Ship-Cancel Race ${label} ${stamp}`,
        slug: `e2e-ship-cancel-race-${label}-${stamp}`,
        description: 'ship-vs-cancel race fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-RACE-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

  const firstFulfillment = async (orderId: number): Promise<IFulfillmentBody> => {
    const { body } = await server()
      .get(`/api/orders/${orderId}/fulfillments`)
      .set('Authorization', adminAuth);
    return (body as IFulfillmentBody[])[0];
  };

  // Places a fresh one-line order (qty 1) and plans one full fulfillment, returning the
  // ids the race needs. Each race gets its own order so the races are independent.
  const placeAndFulfill = async (
    index: number,
  ): Promise<{ orderId: number; fulfillmentId: number }> => {
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
      .set('Idempotency-Key', `ship-cancel-race-${stamp}-${index}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    const order = place.body as IOrderBody;

    const createFul = await server()
      .post(`/api/orders/${order.id}/fulfillments`)
      .set('Authorization', adminAuth)
      .send({ lines: [{ orderLineId: order.lines[0].id, quantity: 1 }] });
    expect(createFul.status).toBe(HttpStatus.CREATED);

    return { orderId: order.id, fulfillmentId: (createFul.body as IFulfillmentBody).id };
  };

  // Fires Ship and Cancel at the SAME order concurrently, capturing both outcomes
  // WITHOUT throwing on a non-2xx (the loser's 4xx is an expected outcome). Both requests
  // are constructed and dispatched in the same tick (Promise.all evaluates the array
  // eagerly), so they truly contend on the fulfillment row lock. Which side reaches the
  // lock first — and so wins — is environment-timing-dependent; the suite asserts NEITHER
  // a specific winner (it classifies each race by its outcome), only that exactly one
  // wins and the loser does not invert state. The deterministic reverse-order rejection
  // (a ship of an already-cancelled fulfillment) is locked separately below.
  const raceShipCancel = async (
    orderId: number,
    fulfillmentId: number,
    index: number,
  ): Promise<{ ship: IRaceOutcome; cancel: IRaceOutcome }> => {
    const [shipRes, cancelRes] = await Promise.all([
      server()
        .post(`/api/orders/${orderId}/fulfillments/${fulfillmentId}/ship`)
        .set('Authorization', adminAuth)
        .set('Idempotency-Key', `ship-cancel-race-ship-${stamp}-${index}`)
        .send({ trackingNumber: '1Z999AA10199999999', carrier: 'UPS' }),
      server()
        .post(`/api/orders/${orderId}/cancel`)
        .set('Authorization', adminAuth)
        .send({ reason: 'concurrent cancel' }),
    ]);
    return {
      ship: { status: shipRes.status, body: shipRes.body as Record<string, unknown> },
      cancel: { status: cancelRes.status, body: cancelRes.body as Record<string, unknown> },
    };
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

    variantId = await provisionVariant('a', 50);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it(
    `runs ${RACE_COUNT} independent ship-vs-cancel races: exactly one side wins each, the loser never inverts state`,
    async () => {
      const winners: ('ship' | 'cancel')[] = [];

      for (let index = 0; index < RACE_COUNT; index++) {
        const { orderId, fulfillmentId } = await placeAndFulfill(index);
        const { ship, cancel } = await raceShipCancel(orderId, fulfillmentId, index);

        // Exactly one 2xx and one 4xx — never both-win (state inversion) or both-lose.
        const wins = [ship, cancel].filter((o) => o.status >= 200 && o.status < 300);
        const losses = [ship, cancel].filter((o) => o.status >= 400 && o.status < 500);
        expect(wins).toHaveLength(1);
        expect(losses).toHaveLength(1);

        const order = await getOrder(orderId);
        const fulfillment = await firstFulfillment(orderId);

        if (ship.status === (HttpStatus.OK as number)) {
          // SHIP WON: the order shipped, so the cancel is rejected because a shipped
          // fulfillment now exists (a state guard, not an authorization failure).
          expect(cancel.status).toBe(HttpStatus.CONFLICT);
          expect(cancel.body.code).toBe('ORDER_NOT_CANCELLABLE');

          expect(order.status).not.toBe('cancelled');
          expect(order.fulfillmentStatus).toBe('shipped');
          expect(order.paymentStatus).toBe('captured');
          expect(order.payment?.status).toBe('captured');
          expect(fulfillment.status).toBe('shipped');
          winners.push('ship');
        } else {
          // CANCEL WON: the order cancelled, so the ship is rejected because the
          // fulfillment is no longer `pending` (a 4xx — the invalid status transition).
          expect(cancel.status).toBe(HttpStatus.OK);
          expect(ship.status).toBe(HttpStatus.CONFLICT);
          expect(ship.body.code).toBe('FULFILLMENT_INVALID_STATUS_TRANSITION');

          expect(order.status).toBe('cancelled');
          // The authorized payment was voided (the payment ROW); the order's payment
          // AXIS keeps its value (no `voided` member there — the two-enum orthogonality).
          expect(order.payment?.status).toBe('voided');
          expect(fulfillment.status).toBe('cancelled');
          winners.push('cancel');
        }
      }

      // Sanity: every race resolved to exactly one winner (winner-agnostic — the mix of
      // ship/cancel winners is environment-timing-dependent and intentionally not pinned).
      expect(winners).toHaveLength(RACE_COUNT);
    },
    timeout,
  );

  // The deterministic analogue of the "cancel wins" race outcome: once an order is
  // cancelled, its (now `cancelled`) fulfillment is no longer shippable. This pins the
  // reverse-order rejection — the same in-transaction status guard that protects the
  // race, exercised sequentially so it is asserted on every run regardless of which side
  // tends to win the live race in this environment.
  it('a ship of an already-cancelled order’s fulfillment is rejected 409 FULFILLMENT_INVALID_STATUS_TRANSITION', async () => {
    const { orderId, fulfillmentId } = await placeAndFulfill(RACE_COUNT);

    const cancel = await server()
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', adminAuth)
      .send({ reason: 'cancel before ship' });
    expect(cancel.status).toBe(HttpStatus.OK);
    expect((cancel.body as IOrderBody).status).toBe('cancelled');

    const ship = await server()
      .post(`/api/orders/${orderId}/fulfillments/${fulfillmentId}/ship`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `ship-cancel-race-after-${stamp}`)
      .send({ trackingNumber: '1Z999AA10188888888', carrier: 'UPS' });
    expect(ship.status).toBe(HttpStatus.CONFLICT);
    expect((ship.body as { code: string }).code).toBe('FULFILLMENT_INVALID_STATUS_TRANSITION');

    // The rejected ship changed nothing: the order stays cancelled, the fulfillment
    // cancelled, the payment voided (never captured).
    const order = await getOrder(orderId);
    expect(order.status).toBe('cancelled');
    expect(order.payment?.status).toBe('voided');
    expect((await firstFulfillment(orderId)).status).toBe('cancelled');
  });
});
