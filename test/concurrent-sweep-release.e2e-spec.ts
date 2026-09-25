import { randomUUID } from 'crypto';

import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { ReservationSweepE2ESpecDataSource } from './data-source/reservation-sweep.e2e-spec.data-source';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const ADMIN_STAFF_USER_ID = '00000000-0000-4000-a000-000000000001';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const CORRELATION_HEADER = 'x-correlation-id';
const DEFAULT_WAREHOUSE = 'default-warehouse';

const RETRY_LOG_MESSAGE = 'Stock write conflict — retrying with a fresh read';
const EXHAUSTED_LOG_MESSAGE = 'Stock write conflict exhausted retry budget';

const SWEEP_DELAYS_MS = [0, 0, 3, 8, 15, 20, 25, 40, 60];
const ON_HAND = 50;
const HELD_QUANTITY = 2;

interface ITokenResponse {
  accessToken: string;
}

interface ICartBody {
  id: string;
  lines: { id: number; variantId: number; quantity: number }[];
}

interface IRaceOutcome {
  status: number;
  body: Record<string, unknown>;
}

interface ISweepBody {
  scanned: number;
  expired: number;
  skipped: number;
  durationMs: number;
}

const capturedLogs = (): Record<string, unknown>[] =>
  (globalThis as { __RIS_E2E_CAPTURED_LOGS__?: Record<string, unknown>[] })
    .__RIS_E2E_CAPTURED_LOGS__ ?? [];

const logsMatching = (needle: string): Record<string, unknown>[] =>
  capturedLogs().filter((record) => typeof record.msg === 'string' && record.msg.includes(needle));

describe('Concurrent sweep vs Remove Line — one hold, one decrement (e2e)', () => {
  const timeout = 120_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let retailDb: ReservationSweepE2ESpecDataSource;

  const stamp = Date.now();
  const previousSweepInterval = process.env.RESERVATION_SWEEP_INTERVAL_SECONDS;

  let adminAuth: string;
  let customerToken: string;
  let variantId: number;

  const winners: string[] = [];

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const waitForStockRow = async (id: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await retailDb.getStockLevelRows(id)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${id}`);
      }
      await sleep(100);
    }
  };

  const removeLine = async (cartId: string, lineId: number): Promise<IRaceOutcome> => {
    const res = await server()
      .delete(`/api/cart/${cartId}/lines/${lineId}`)
      .set('Authorization', `Bearer ${customerToken}`);
    return { status: res.status, body: res.body as Record<string, unknown> };
  };

  const sweep = async (correlationId: string): Promise<IRaceOutcome> => {
    const res = await server()
      .post('/api/inventory/reservations/sweep')
      .set('Authorization', adminAuth)
      .set(CORRELATION_HEADER, correlationId)
      .send({});
    return { status: res.status, body: res.body as Record<string, unknown> };
  };

  const createMicroservice = (
    appModule: unknown,
    queue: MicroserviceQueueEnum,
  ): Promise<INestMicroservice> =>
    NestFactory.createMicroservice<MicroserviceOptions>(appModule as never, {
      logger: false,
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL!],
        queue,
        queueOptions: { durable: true },
      },
    });

  const openStaleHold = async (): Promise<{
    cartId: string;
    lineId: number;
    reservationId: string;
    reservedWithHold: number;
  }> => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    expect(create.status).toBe(HttpStatus.CREATED);
    const cartId = (create.body as ICartBody).id;

    const addLine = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: HELD_QUANTITY });
    expect(addLine.status).toBe(HttpStatus.OK);
    const lineId = (addLine.body as ICartBody).lines[0].id;

    const holds = await retailDb.getReservationsByCartId(cartId);
    expect(holds).toHaveLength(1);
    expect(holds[0].status).toBe('active');

    const reservedWithHold = (await retailDb.getStockLevel(variantId, DEFAULT_WAREHOUSE))!
      .quantityReserved;

    await retailDb.ageReservation(holds[0].id, new Date(Date.now() - 60_000));

    return { cartId, lineId, reservationId: holds[0].id, reservedWithHold };
  };

  const assertSettledExactlyOnce = async (
    cartId: string,
    reservationId: string,
    reservedWithHold: number,
  ): Promise<'sweep' | 'remove-line'> => {
    const hold = await retailDb.getReservationById(reservationId);
    expect(hold).toBeDefined();
    expect(['released', 'expired']).toContain(hold!.status);

    const level = await retailDb.getStockLevel(variantId, DEFAULT_WAREHOUSE);
    expect(level!.quantityReserved).toBe(reservedWithHold - HELD_QUANTITY);
    expect(level!.quantityOnHand).toBe(ON_HAND);
    expect(level!.quantityReserved).toBeGreaterThanOrEqual(0);

    const releases = (await retailDb.getMovementsByCartAndVariant(cartId, variantId)).filter(
      (m) => m.type === 'release',
    );
    expect(releases).toHaveLength(1);
    expect(releases[0].quantity).toBe(-HELD_QUANTITY);

    if (hold!.status === 'expired') {
      expect(releases[0].reasonCode).toBe('expired');
      expect(releases[0].actorId).toBe(ADMIN_STAFF_USER_ID);
      return 'sweep';
    }
    expect(releases[0].reasonCode).toBe('cart-removed');
    expect(releases[0].actorId).toBeNull();
    return 'remove-line';
  };

  beforeAll(async () => {
    process.env.RESERVATION_SWEEP_INTERVAL_SECONDS = '3600';
    const inventoryModule = await import('@retail-inventory-system/apps/inventory-microservice');

    retailMicroservice = await createMicroservice(
      RetailMicroserviceAppModule,
      MicroserviceQueueEnum.RETAIL_QUEUE,
    );
    catalogMicroservice = await createMicroservice(
      CatalogMicroserviceAppModule,
      MicroserviceQueueEnum.CATALOG_QUEUE,
    );
    inventoryMicroservice = await createMicroservice(
      inventoryModule.AppModule,
      MicroserviceQueueEnum.INVENTORY_QUEUE,
    );

    await Promise.all([
      retailMicroservice.listen(),
      catalogMicroservice.listen(),
      inventoryMicroservice.listen(),
    ]);

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.listen(0);

    retailDb = new ReservationSweepE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
      timezone: 'Z',
    });
    await retailDb.initialize();

    const adminLogin = await server()
      .post('/api/auth/staff/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminAuth = `Bearer ${(adminLogin.body as ITokenResponse).accessToken}`;

    const customerLogin = await server()
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    customerToken = (customerLogin.body as ITokenResponse).accessToken;

    await sweep(`sweep-race-drain-${stamp}`);

    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Sweep Race ${stamp}`,
        slug: `e2e-sweep-race-${stamp}`,
        description: 'sweep-vs-release race fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-SWPR-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    variantId = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variantId}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });
    expect(priceRes.status).toBe(HttpStatus.CREATED);

    await settleTimestampRounding();

    const publishRes = await server()
      .post(`/api/catalog/products/${productId}/publish`)
      .set('Authorization', adminAuth);
    expect(publishRes.status).toBe(HttpStatus.OK);

    await waitForStockRow(variantId);

    const receiveRes = await server()
      .post(`/api/inventory/variants/${variantId}/stock/receive`)
      .set('Authorization', adminAuth)
      .send({ quantity: ON_HAND });
    expect(receiveRes.status).toBe(HttpStatus.OK);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await retailDb?.destroy();

    if (previousSweepInterval === undefined) {
      delete process.env.RESERVATION_SWEEP_INTERVAL_SECONDS;
    } else {
      process.env.RESERVATION_SWEEP_INTERVAL_SECONDS = previousSweepInterval;
    }
  });

  it(
    `settles ${SWEEP_DELAYS_MS.length} races across the interleaving window, decrementing quantity_reserved once each`,
    async () => {
      for (const [index, delayMs] of SWEEP_DELAYS_MS.entries()) {
        const { cartId, lineId, reservationId, reservedWithHold } = await openStaleHold();
        const correlationId = `sweep-race-${stamp}-${index}-${randomUUID()}`;

        const [removeOutcome, sweepOutcome] = await Promise.all([
          removeLine(cartId, lineId),
          (async (): Promise<IRaceOutcome> => {
            if (delayMs > 0) {
              await sleep(delayMs);
            }
            return sweep(correlationId);
          })(),
        ]);

        expect(removeOutcome.status).toBe(HttpStatus.OK);
        expect(sweepOutcome.status).toBe(HttpStatus.OK);

        const counters = sweepOutcome.body as unknown as ISweepBody;
        expect(counters.scanned).toBe(counters.expired + counters.skipped);
        expect(counters.expired).toBeLessThanOrEqual(1);

        const winner = await assertSettledExactlyOnce(cartId, reservationId, reservedWithHold);
        winners.push(winner);

        expect(counters.expired).toBe(winner === 'sweep' ? 1 : 0);
      }

      expect(winners).toHaveLength(SWEEP_DELAYS_MS.length);
    },
    timeout,
  );

  it(
    'a sweep that arrives after the release is a no-op: nothing expires, no second release row',
    async () => {
      const { cartId, lineId, reservationId, reservedWithHold } = await openStaleHold();

      const removeOutcome = await removeLine(cartId, lineId);
      expect(removeOutcome.status).toBe(HttpStatus.OK);

      const sweepOutcome = await sweep(`sweep-race-${stamp}-after-release-${randomUUID()}`);
      expect(sweepOutcome.status).toBe(HttpStatus.OK);
      const counters = sweepOutcome.body as unknown as ISweepBody;
      expect(counters.expired).toBe(0);
      expect(counters.scanned).toBe(counters.expired + counters.skipped);

      const winner = await assertSettledExactlyOnce(cartId, reservationId, reservedWithHold);
      expect(winner).toBe('remove-line');
    },
    timeout,
  );

  it('any optimistic retry the losers burned was logged, and the budget was never exhausted', () => {
    for (const record of logsMatching(RETRY_LOG_MESSAGE)) {
      expect(typeof record.attempt).toBe('number');
      expect(record.variantId).toBeDefined();
    }

    expect(logsMatching(EXHAUSTED_LOG_MESSAGE)).toHaveLength(0);
  });
});
