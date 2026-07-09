import { randomUUID } from 'crypto';

import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as EventStoreMicroserviceAppModule } from '@retail-inventory-system/apps/event-store-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { EventStoreE2ESpecDataSource } from './data-source/event-store.e2e-spec.data-source';
import { ReservationSweepE2ESpecDataSource } from './data-source/reservation-sweep.e2e-spec.data-source';

// The operator-triggered reservation sweep, end to end (ADR-038). A cart line holds
// stock; the hold is aged past its TTL; `POST /api/inventory/reservations/sweep`
// reclaims it. The suite follows the reclaim through every surface it touches: the
// `reservation` row's terminal status, the `stock_level` counters, the append-only
// `stock_movement` ledger, the cache-aside HTTP stock read, and — one bus hop later —
// the `ris_eventstore.domain_event` row the emitted `inventory.stock.released` lands in.
//
// TWO ENVIRONMENT FACTS make this suite deterministic, and both are load-bearing:
//
//   1. `RESERVATION_SWEEP_INTERVAL_SECONDS` is pushed far out of the way BEFORE the
//      inventory app module is loaded. The service's own timer runs the exact same use
//      case; left at its 60-second default it would race the manual trigger and reclaim
//      the hold first, turning `expired: 1` into `expired: 0`. The override must precede
//      the module's `ConfigModule.forRoot(...)`, which validates and SNAPSHOTS the
//      environment the moment `app.module.ts` is imported — a snapshot `ConfigService`
//      then reads ahead of `process.env`. Hence the dynamic `import()` below: a static
//      import is hoisted above every statement in this file and would take the snapshot
//      with the default still in place. The cron suite makes the mirror-image override
//      for the same reason.
//
//   2. A drain sweep runs once during setup. The reclaim is global — it acts on every
//      `active` hold whose `expires_at` has passed, not just this suite's — so a hold
//      left stale by an earlier run (or a long-lived local database) would inflate
//      `expired`. Draining first makes the counted sweep below see exactly one candidate.
//
// The suite ages `reservation.expires_at` by direct SQL. That is the only way to make a
// hold stale without waiting out `RESERVATION_TTL_MINUTES`, and it is deliberate that no
// production API can do it — see `ReservationSweepE2ESpecDataSource.ageReservation`.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const ADMIN_STAFF_USER_ID = '00000000-0000-4000-a000-000000000001';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const CORRELATION_HEADER = 'x-correlation-id';
const DEFAULT_WAREHOUSE = 'default-warehouse';

const KEY_STOCK_RELEASED = 'inventory.stock.released';

const ON_HAND = 10;
const HELD_QUANTITY = 3;

interface ITokenResponse {
  accessToken: string;
}

interface ICartBody {
  id: string;
  lines: { id: number; variantId: number; quantity: number }[];
}

interface ISweepBody {
  scanned: number;
  expired: number;
  skipped: number;
  durationMs: number;
}

interface IStockLevelBody {
  stockLocationId: string;
  quantityOnHand: number;
  quantityAllocated: number;
  quantityReserved: number;
  available: number;
}

interface IVariantStockBody {
  locations: IStockLevelBody[];
}

describe('Reservation sweeper — the manual trigger reclaims a stale hold (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let eventStoreMicroservice: INestMicroservice;
  let retailDb: ReservationSweepE2ESpecDataSource;
  let eventStore: EventStoreE2ESpecDataSource;

  const stamp = Date.now();
  const sweepCorrelationId = `sweep-${stamp}-${randomUUID()}`;
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

  const sweep = async (correlationId?: string): Promise<ISweepBody> => {
    const request = server()
      .post('/api/inventory/reservations/sweep')
      .set('Authorization', adminAuth);
    if (correlationId !== undefined) {
      request.set(CORRELATION_HEADER, correlationId);
    }
    const res = await request.send({});
    expect(res.status).toBe(HttpStatus.OK);
    return res.body as ISweepBody;
  };

  const warehouseLevel = async (): Promise<IStockLevelBody> => {
    const { body } = await server().get(`/api/inventory/variants/${variantId}/stock`);
    const stock = body as IVariantStockBody;
    const level = stock.locations.find((l) => l.stockLocationId === DEFAULT_WAREHOUSE);
    if (level === undefined) {
      throw new Error(`No ${DEFAULT_WAREHOUSE} level in the public stock read`);
    }
    return level;
  };

  // Ingestion is asynchronous (publish → broker → consume → insert), so poll rather than
  // read once — the `event-store-firehose.e2e-spec.ts` recipe.
  const waitForReleasedEvent = async (deadlineMs = 30_000): Promise<Record<string, unknown>> => {
    const start = Date.now();
    for (;;) {
      const rows = await eventStore.getDomainEventsByCorrelationId(sweepCorrelationId);
      const released = rows.find(
        (row) => row.eventType === KEY_STOCK_RELEASED && row.aggregateId === String(variantId),
      );
      if (released !== undefined) {
        return released.payload;
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(
          `Timed out waiting for ${KEY_STOCK_RELEASED} under ${sweepCorrelationId}. ` +
            `Present: [${rows.map((r) => r.eventType).join(', ')}]`,
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
    // See the header, fact 1. Set BEFORE the dynamic import, never after.
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

    // The firehose shape of the event store's `main.ts`: `#` on the `ris.events` topic
    // exchange, so the `inventory.stock.released` the sweep emits is ingested.
    eventStoreMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      EventStoreMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL!],
          noAck: false,
          queue: MicroserviceQueueEnum.EVENT_STORE_FIREHOSE_QUEUE,
          queueOptions: { durable: true },
          exchange: 'ris.events',
          exchangeType: 'topic',
          wildcards: true,
        },
      },
    );

    await Promise.all([
      retailMicroservice.listen(),
      catalogMicroservice.listen(),
      inventoryMicroservice.listen(),
      eventStoreMicroservice.listen(),
    ]);

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    // `timezone: 'Z'` matches the app's `DatabaseModule` — the ageing write below and the
    // sweep's `now` must agree on the wall clock.
    retailDb = new ReservationSweepE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
      timezone: 'Z',
    });
    await retailDb.initialize();

    eventStore = new EventStoreE2ESpecDataSource({
      type: 'mysql',
      url: process.env.EVENTSTORE_DATABASE_URL!,
      timezone: 'Z',
    });
    await eventStore.initialize();

    const adminLogin = await server()
      .post('/api/auth/staff/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminAuth = `Bearer ${(adminLogin.body as ITokenResponse).accessToken}`;

    const customerLogin = await server()
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    customerToken = (customerLogin.body as ITokenResponse).accessToken;

    // See the header, fact 2: clear any hold an earlier run left stale, so the counted
    // sweep sees exactly the one candidate this suite creates.
    await sweep();

    // Self-provisioned, disjoint fixture — its own product/variant/price/stock, so the
    // shared seeded variants are untouched.
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Sweeper ${stamp}`,
        slug: `e2e-sweeper-${stamp}`,
        description: 'reservation-sweeper fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-SWP-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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
    await eventStoreMicroservice?.close();
    await retailDb?.destroy();
    await eventStore?.destroy();

    if (previousSweepInterval === undefined) {
      delete process.env.RESERVATION_SWEEP_INTERVAL_SECONDS;
    } else {
      process.env.RESERVATION_SWEEP_INTERVAL_SECONDS = previousSweepInterval;
    }
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
    expect(holds[0].quantity).toBe(HELD_QUANTITY);
    expect(holds[0].variantId).toBe(variantId);
    expect(holds[0].stockLocationId).toBe(DEFAULT_WAREHOUSE);
    reservationId = holds[0].id;
    reservationVersionBeforeSweep = holds[0].version;

    const levelAfter = await retailDb.getStockLevel(variantId, DEFAULT_WAREHOUSE);
    expect(levelAfter!.quantityReserved).toBe(reservedBeforeHold + HELD_QUANTITY);
    expect(levelAfter!.quantityOnHand).toBe(ON_HAND);
  });

  it('the manual sweep expires exactly the aged hold and reports scanned = expired + skipped', async () => {
    // The escape hatch: one minute into the past, so `expires_at < now` inside the scan.
    await retailDb.ageReservation(reservationId, new Date(Date.now() - 60_000));

    const aged = await retailDb.getReservationById(reservationId);
    expect(aged!.status).toBe('active');
    expect(aged!.expiresAt.getTime()).toBeLessThan(Date.now());

    const result = await sweep(sweepCorrelationId);

    expect(result.expired).toBe(1);
    expect(result.scanned).toBe(result.expired + result.skipped);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('the hold is expired with an advanced version; reserved is returned, on-hand untouched', async () => {
    const hold = await retailDb.getReservationById(reservationId);
    expect(hold!.status).toBe('expired');
    // `expire()` bumps the optimistic token — proof the aggregate was mutated and
    // version-checked-persisted, not merely re-read.
    expect(hold!.version).toBeGreaterThan(reservationVersionBeforeSweep);

    const level = await retailDb.getStockLevel(variantId, DEFAULT_WAREHOUSE);
    // A release moves the reserved counter and NOTHING else: `available` rises because
    // the hold stopped subtracting from it, never because units appeared.
    expect(level!.quantityReserved).toBe(reservedBeforeHold);
    expect(level!.quantityOnHand).toBe(ON_HAND);
    expect(level!.quantityAllocated).toBe(0);
  });

  it('appends exactly one negative release movement attributed to the acting admin', async () => {
    const movements = await retailDb.getMovementsByCartAndVariant(cartId, variantId);
    const releases = movements.filter((m) => m.type === 'release');

    expect(releases).toHaveLength(1);
    expect(releases[0].quantity).toBe(-HELD_QUANTITY);
    expect(releases[0].reasonCode).toBe('expired');
    expect(releases[0].referenceType).toBe('cart');
    expect(releases[0].referenceId).toBe(cartId);
    // The one behavioural difference between an operator sweep and a timer tick.
    expect(releases[0].actorId).toBe(ADMIN_STAFF_USER_ID);
    expect(releases[0].stockLocationId).toBe(DEFAULT_WAREHOUSE);
  });

  it('the public stock read reports the restored availability (the cache was invalidated)', async () => {
    // A cache-aside read: had `withInvalidation` not wiped the variant's prefix after the
    // commit, this would still serve the pre-sweep `available`.
    const level = await warehouseLevel();
    expect(level.quantityReserved).toBe(reservedBeforeHold);
    expect(level.available).toBe(ON_HAND - reservedBeforeHold);
  });

  it('ingests inventory.stock.released into the event store, carrying the reason and the hold id', async () => {
    const payload = await waitForReleasedEvent();

    expect(payload.reason).toBe('expired');
    expect(payload.reservationId).toBe(reservationId);
    expect(payload.cartId).toBe(cartId);
    expect(payload.quantity).toBe(HELD_QUANTITY);
    expect(payload.variantId).toBe(variantId);
  });

  it('a second sweep is a no-op: nothing expires and no second release row is written', async () => {
    const result = await sweep();

    // The set the sweep acts on is `status = 'active' AND expires_at < now`; acting on a
    // row removes it from that set. Idempotence is structural, not guarded.
    expect(result.expired).toBe(0);

    const releases = (await retailDb.getMovementsByCartAndVariant(cartId, variantId)).filter(
      (m) => m.type === 'release',
    );
    expect(releases).toHaveLength(1);

    const level = await retailDb.getStockLevel(variantId, DEFAULT_WAREHOUSE);
    expect(level!.quantityReserved).toBe(reservedBeforeHold);
  });
});
