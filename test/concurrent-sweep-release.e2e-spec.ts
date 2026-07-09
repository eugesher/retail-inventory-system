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

// THE sweep-vs-release proof (ADR-038 + ADR-036). Two writers reach for the same stale
// hold: the shopper removes the cart line (releasing it, reason `cart-removed`) and an
// operator sweeps (expiring it, reason `expired`). Both return the held units to
// `available` by decrementing `stock_level.quantity_reserved`. Exactly one of them may.
//
// Nothing locks the candidate set. Two mechanisms settle the race instead:
//
//   1. Inside its transaction each writer RE-READS the reservation by id and refuses a
//      row that is no longer `active`. The sweep counts such a row as `skipped`; the
//      release resolves an empty match and returns an idempotent no-op.
//   2. The write to `stock_level` is a version-checked compare-and-swap. A writer whose
//      snapshot went stale between its read and its `UPDATE … WHERE version = ?` matches
//      zero rows, raises `StockWriteConflictError`, and `runWithStockWriteRetry` re-opens
//      a fresh transaction — where guard (1) now sees the winner's committed status.
//
// Together they buy one invariant: **`quantity_reserved` is decremented exactly once per
// hold**, and the append-only ledger carries exactly one `release` row for it.
//
// NEITHER LOSER FAILS ITS CALLER. A sweep that skips answers `200 { expired: 0,
// skipped: 1 }`; a Remove Line that loses answers `200` with the line gone (its release
// leg is best-effort by design — the cart write is the primary outcome). Both are 2xx.
//
// WHY A STAIRCASE, NOT `Promise.all` TWICE. The two callers reach the same reservation
// row over asymmetric paths: the sweep goes straight to `inventory_queue`, while Remove
// Line first commits the cart in `retail_db` and only then releases over RPC. Fired in
// the same tick the sweep therefore wins *every* time, and the loser-is-the-sweep branch
// never runs. So each race staggers the sweep by a growing delay, walking the whole
// interleaving window. Three regimes are real and all three are correct:
//
//   | sweep delay | who wins    | sweep counters                       |
//   | ----------- | ----------- | ------------------------------------ |
//   | ~0 ms       | sweep       | `scanned 1, expired 1, skipped 0`     |
//   | ~20 ms      | Remove Line | `scanned 1, expired 0, skipped 1`     |
//   | ~40 ms+     | Remove Line | `scanned 0` — settled before the scan |
//
// The exact boundaries are machine-dependent, so the suite asserts what must hold in
// EVERY regime and classifies each race by the terminal status it reads back — never by
// the delay it used. The last test then pins the loser-is-the-sweep branch
// deterministically, by awaiting the release before sweeping at all.
//
// The sweep TIMER is pushed far into the future before the inventory app module loads:
// the race under test is between the operator and the shopper, and an unattended tick
// reclaiming the hold first would settle it before either racer started.
// `ConfigModule.forRoot(...)` snapshots the environment at import time, so the override
// must precede a dynamic `import()` — a static one is hoisted above it.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const ADMIN_STAFF_USER_ID = '00000000-0000-4000-a000-000000000001';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const CORRELATION_HEADER = 'x-correlation-id';
const DEFAULT_WAREHOUSE = 'default-warehouse';

const RETRY_LOG_MESSAGE = 'Stock write conflict — retrying with a fresh read';
const EXHAUSTED_LOG_MESSAGE = 'Stock write conflict exhausted retry budget';

// One race per entry: how long the sweep waits after Remove Line is launched.
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

// The e2e Pino capture installed by `test/jest.setup.ts` collects raw records, so `msg` is
// `unknown` — a non-string one must not be coerced into `[object Object]` and matched.
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

  // Which side won each race. Reported, never asserted on: the schedule makes both
  // outcomes likely but a loaded box can slow either racer, and demanding a particular
  // mix would be exactly the flake this suite exists to rule out.
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

  // Fire one call and capture its outcome WITHOUT throwing on a non-2xx — a loser's
  // status is data the test classifies, not an error it aborts on.
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

  // Open a cart holding `HELD_QUANTITY` of the fixture variant, then age the hold past
  // its TTL so it is a sweep candidate. Returns everything a race needs to assert.
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

    // `R`: the reserved counter WITH this hold counted in. The invariant is `R - q`.
    const reservedWithHold = (await retailDb.getStockLevel(variantId, DEFAULT_WAREHOUSE))!
      .quantityReserved;

    // The test-only escape hatch — one minute into the past makes the hold a candidate.
    await retailDb.ageReservation(holds[0].id, new Date(Date.now() - 60_000));

    return { cartId, lineId, reservationId: holds[0].id, reservedWithHold };
  };

  // The assertions that must hold no matter who won.
  const assertSettledExactlyOnce = async (
    cartId: string,
    reservationId: string,
    reservedWithHold: number,
  ): Promise<'sweep' | 'remove-line'> => {
    const hold = await retailDb.getReservationById(reservationId);
    expect(hold).toBeDefined();
    // Exactly one terminal state — never both, never still `active`.
    expect(['released', 'expired']).toContain(hold!.status);

    // THE assertion this whole slice exists to make true. Not `R - 2q`.
    const level = await retailDb.getStockLevel(variantId, DEFAULT_WAREHOUSE);
    expect(level!.quantityReserved).toBe(reservedWithHold - HELD_QUANTITY);
    expect(level!.quantityOnHand).toBe(ON_HAND);
    expect(level!.quantityReserved).toBeGreaterThanOrEqual(0);

    // Exactly ONE `release` row for this hold. Whichever writer lost re-read the row,
    // saw a non-`active` status, and wrote nothing.
    const releases = (await retailDb.getMovementsByCartAndVariant(cartId, variantId)).filter(
      (m) => m.type === 'release',
    );
    expect(releases).toHaveLength(1);
    expect(releases[0].quantity).toBe(-HELD_QUANTITY);

    // The ledger records WHO won: only an operator sweep carries a staff principal, and
    // the reason code is the winner's own vocabulary.
    if (hold!.status === 'expired') {
      expect(releases[0].reasonCode).toBe('expired');
      expect(releases[0].actorId).toBe(ADMIN_STAFF_USER_ID);
      return 'sweep';
    }
    expect(releases[0].reasonCode).toBe('cart-removed');
    // The retail Remove Line forwards no staff principal — a shopper is not an actor on
    // the inventory ledger.
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
    // `listen(0)`, not the usual `init()`. When `server.address()` is null, `supertest`
    // binds an ephemeral port itself — and the Test that bound it CLOSES the listener the
    // moment its own request finishes. This suite deliberately staggers its two calls, so
    // the earlier one would tear the socket out from under the later one and the race
    // would surface as `ECONNRESET` instead of as an outcome. Binding once here leaves
    // `address()` non-null, so every `supertest(...)` reuses the live listener and none of
    // them owns its lifetime. `app.close()` releases it.
    await apiGatewayApp.listen(0);

    // `timezone: 'Z'` matches the app's `DatabaseModule` — the ageing write and the
    // sweep's `now` must agree on the wall clock.
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

    // The sweep acts on every stale `active` hold in the database, not just this suite's.
    // Drain whatever an earlier run left behind, so each race's counters describe only
    // the hold it created.
    await sweep(`sweep-race-drain-${stamp}`);

    // Self-provisioned, disjoint fixture with ample stock: the contention under test is
    // on ONE reservation row, never on availability.
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

        // Both in flight together; only the sweep's start is staggered.
        const [removeOutcome, sweepOutcome] = await Promise.all([
          removeLine(cartId, lineId),
          (async (): Promise<IRaceOutcome> => {
            if (delayMs > 0) {
              await sleep(delayMs);
            }
            return sweep(correlationId);
          })(),
        ]);

        // Neither loser fails its caller.
        expect(removeOutcome.status).toBe(HttpStatus.OK);
        expect(sweepOutcome.status).toBe(HttpStatus.OK);

        const counters = sweepOutcome.body as unknown as ISweepBody;
        // A skipped candidate is one a concurrent writer had already settled.
        expect(counters.scanned).toBe(counters.expired + counters.skipped);
        expect(counters.expired).toBeLessThanOrEqual(1);

        const winner = await assertSettledExactlyOnce(cartId, reservationId, reservedWithHold);
        winners.push(winner);

        // The counters and the row agree on who won.
        expect(counters.expired).toBe(winner === 'sweep' ? 1 : 0);
      }

      expect(winners).toHaveLength(SWEEP_DELAYS_MS.length);
    },
    timeout,
  );

  it(
    'a sweep that arrives after the release is a no-op: nothing expires, no second release row',
    async () => {
      // The loser-is-the-sweep branch, pinned without depending on a timing window: the
      // release is fully committed before the sweep is even issued. Its candidate scan
      // filters on `status = 'active'`, so the settled hold is not a candidate at all.
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
    // A SOFT assertion, and deliberately so: an interleaving in which one writer commits
    // before the other reads produces ZERO compare-and-swap conflicts and is equally
    // correct. What must hold is that when a conflict DID happen, the retry left a trace —
    // an `info` line naming the row and the attempt (ADR-036), not a swallowed exception.
    for (const record of logsMatching(RETRY_LOG_MESSAGE)) {
      expect(typeof record.attempt).toBe('number');
      expect(record.variantId).toBeDefined();
    }

    // Exhaustion is NOT soft: it surfaces a 409 to a caller, and every caller above
    // returned 200.
    expect(logsMatching(EXHAUSTED_LOG_MESSAGE)).toHaveLength(0);
  });
});
