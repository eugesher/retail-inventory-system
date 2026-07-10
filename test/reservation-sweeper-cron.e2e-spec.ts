import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { SchedulerRegistry } from '@nestjs/schedule';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { RESERVATION_SWEEP_INTERVAL_NAME } from '../apps/inventory-microservice/src/modules/stock/infrastructure/scheduling';
import { ReservationSweepE2ESpecDataSource } from './data-source/reservation-sweep.e2e-spec.data-source';

// The timer-driven half of the reservation sweep (ADR-038). Nobody asks: the hold is
// aged past its TTL and then simply left alone, and `ReservationSweepScheduler` reclaims
// it on its own cadence. Same use case, same ledger row, one difference — `actor_id` is
// NULL, because a tick has no staff principal. That single column is why `actorId` is
// threaded through the sweep at all, and asserting it here is the point of this suite.
//
// THE CADENCE OVERRIDE. `RESERVATION_SWEEP_INTERVAL_SECONDS` is pushed down to 2 seconds
// so the suite finishes in seconds rather than in a minute. The assignment must happen
// BEFORE the inventory app module is loaded: `ConfigModule.forRoot(...)` validates and
// snapshots the environment when `app.module.ts` is imported, and `ConfigService` reads
// that snapshot ahead of `process.env`. A static `import` is hoisted above every
// statement in the file, so the module is loaded through a dynamic `import()` inside
// `beforeAll`, after the override lands. The manual-sweep and race suites make the
// opposite override (a cadence far in the future) for the same reason: there, the timer
// would race their explicit trigger.
//
// POLLING, NOT SLEEPING. The suite polls `reservation.status` at a short interval up to a
// bounded deadline instead of sleeping past one expected tick. A fixed sleep encodes an
// assumption about how quickly a loaded CI box gets round to a timer callback; a poll
// encodes only the outcome. The same reasoning as the firehose suite's ingest poll.
//
// The interval is registered imperatively through `SchedulerRegistry` (an injected
// cadence cannot ride a schedule decorator's compile-time argument), so it outlives the
// Nest container unless `onModuleDestroy` deletes it. A leaked `setInterval` keeps the
// Node event loop alive and the Jest worker never exits — the last assertion here is that
// closing the app takes the timer with it.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';

const SWEEP_INTERVAL_SECONDS = '2';
const ON_HAND = 8;
const HELD_QUANTITY = 2;

interface ITokenResponse {
  accessToken: string;
}

interface ICartBody {
  id: string;
}

describe('Reservation sweeper — the timer reclaims a stale hold unprompted (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let retailDb: ReservationSweepE2ESpecDataSource;
  let schedulerRegistry: SchedulerRegistry;

  const stamp = Date.now();
  const previousSweepInterval = process.env.RESERVATION_SWEEP_INTERVAL_SECONDS;

  let adminAuth: string;
  let customerToken: string;
  let variantId: number;
  let cartId: string;
  let reservationId: string;
  let reservationVersionBeforeSweep: number;
  let reservedBeforeHold: number;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const waitForStockRow = async (id: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await retailDb.getStockLevelRows(id)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${id}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  // Poll for the terminal status rather than sleeping past one tick.
  const waitForExpiry = async (deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    for (;;) {
      const hold = await retailDb.getReservationById(reservationId);
      if (hold !== undefined && hold.status !== 'active') {
        return;
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(
          `Timed out waiting for the timer to expire reservation ${reservationId} ` +
            `(cadence ${SWEEP_INTERVAL_SECONDS}s)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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

  beforeAll(async () => {
    // See the header. Set BEFORE the dynamic import, never after.
    process.env.RESERVATION_SWEEP_INTERVAL_SECONDS = SWEEP_INTERVAL_SECONDS;
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

    schedulerRegistry = inventoryMicroservice.get(SchedulerRegistry, { strict: false });

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

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

    // Self-provisioned, disjoint fixture.
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Sweeper Cron ${stamp}`,
        slug: `e2e-sweeper-cron-${stamp}`,
        description: 'reservation-sweeper timer fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-SWPC-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

    // Capture the assertion's subject BEFORE tearing the rest down, then assert LAST. A
    // failing `expect` here throws, and anything after it would never run: the mysql pool
    // would stay open and the worker would hang on the leak instead of reporting the leak.
    const timerSurvivedClose = schedulerRegistry.doesExist(
      'interval',
      RESERVATION_SWEEP_INTERVAL_NAME,
    );

    await retailDb?.destroy();

    if (previousSweepInterval === undefined) {
      delete process.env.RESERVATION_SWEEP_INTERVAL_SECONDS;
    } else {
      process.env.RESERVATION_SWEEP_INTERVAL_SECONDS = previousSweepInterval;
    }

    // Closing the container must take the imperatively-registered timer with it. If this
    // ever fails, `onModuleDestroy` stopped calling `deleteInterval` — fix the scheduler,
    // never paper over the hanging worker with `--forceExit`.
    expect(timerSurvivedClose).toBe(false);
  });

  it('arms the sweep timer at the configured cadence', () => {
    // The override reached the value provider, and the scheduler registered under the
    // name `onModuleDestroy` will later delete.
    expect(schedulerRegistry.doesExist('interval', RESERVATION_SWEEP_INTERVAL_NAME)).toBe(true);
  });

  it('a cart line opens an active hold and lifts quantity_reserved', async () => {
    const levelBefore = await retailDb.getStockLevel(variantId, DEFAULT_WAREHOUSE);
    reservedBeforeHold = levelBefore!.quantityReserved;

    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    expect(create.status).toBe(HttpStatus.CREATED);
    cartId = (create.body as ICartBody).id;

    const addLine = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: HELD_QUANTITY });
    expect(addLine.status).toBe(HttpStatus.OK);

    const holds = await retailDb.getReservationsByCartId(cartId);
    expect(holds).toHaveLength(1);
    expect(holds[0].status).toBe('active');
    reservationId = holds[0].id;
    reservationVersionBeforeSweep = holds[0].version;

    const levelAfter = await retailDb.getStockLevel(variantId, DEFAULT_WAREHOUSE);
    expect(levelAfter!.quantityReserved).toBe(reservedBeforeHold + HELD_QUANTITY);
  });

  it('the timer expires the aged hold with nobody asking', async () => {
    // The only test-only write in the suite: age the hold past its TTL. Nothing else is
    // triggered — no HTTP call, no RPC, no scheduler poke.
    await retailDb.ageReservation(reservationId, new Date(Date.now() - 60_000));

    await waitForExpiry();

    const hold = await retailDb.getReservationById(reservationId);
    expect(hold!.status).toBe('expired');
    expect(hold!.version).toBeGreaterThan(reservationVersionBeforeSweep);
  });

  it('returns the reserved units and leaves on-hand untouched', async () => {
    const level = await retailDb.getStockLevel(variantId, DEFAULT_WAREHOUSE);
    expect(level!.quantityReserved).toBe(reservedBeforeHold);
    expect(level!.quantityOnHand).toBe(ON_HAND);
    expect(level!.quantityAllocated).toBe(0);
  });

  it('appends one negative release movement with a NULL actor — a tick has no principal', async () => {
    const releases = (await retailDb.getMovementsByCartAndVariant(cartId, variantId)).filter(
      (m) => m.type === 'release',
    );

    expect(releases).toHaveLength(1);
    expect(releases[0].quantity).toBe(-HELD_QUANTITY);
    expect(releases[0].reasonCode).toBe('expired');
    expect(releases[0].referenceType).toBe('cart');
    expect(releases[0].referenceId).toBe(cartId);
    // The assertion the whole `actorId` thread exists to make: unattended means unowned.
    expect(releases[0].actorId).toBeNull();
  });
});
