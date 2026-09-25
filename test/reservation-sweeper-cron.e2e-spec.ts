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

    expect(timerSurvivedClose).toBe(false);
  });

  it('arms the sweep timer at the configured cadence', () => {
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
    expect(releases[0].actorId).toBeNull();
  });
});
