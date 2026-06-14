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

// THE canonical concurrent-oversell proof (ADR-030). Two carts race to reserve the
// last unit of a freshly-provisioned variant (on-hand 1). The no-oversell guard
// (`StockLevel.reserve` throws OUT_OF_STOCK when the ask exceeds `available`) runs
// inside the bounded optimistic write protocol (version-checked compare-and-swap,
// retried), so EXACTLY ONE racer wins; the other gets `409 INVENTORY_OUT_OF_STOCK`
// with `available: 0`. After the winner places, the final state is consistent:
// on-hand 1 / allocated 1 / reserved 0 / available 0, exactly one `allocation`
// ledger row, and no negative counters anywhere.
//
// Stability contract: the suite never assumes WHICH racer wins (it sums the
// outcomes), never sleeps to "let things settle", and asserts DB-backed reads (the
// public stock read + the uncached movements ledger) — never a broker side effect
// or an event spy. It must stay green across 5 consecutive runs after one infra
// reload (the exact command lives in the implementation doc).
//
// Self-provisioned, disjoint fixtures (`e2e-oversell-*`): every scenario gets its
// own variant with on-hand 1, so the shared seeded variants are never touched and
// the two scenarios cannot interfere.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';

const ADDRESS = {
  recipientName: 'Race Winner',
  line1: '1 Market St',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94105',
  country: 'US',
};

interface ITokenResponse {
  accessToken: string;
}

interface IStockLevelBody {
  stockLocationId: string;
  quantityOnHand: number;
  quantityAllocated: number;
  quantityReserved: number;
  available: number;
}

interface IVariantStockBody {
  variantId: number;
  totalOnHand: number;
  totalAvailable: number;
  locations: IStockLevelBody[];
}

interface ICartBody {
  id: string;
}

interface IOrderBody {
  id: number;
}

interface IMovementBody {
  id: number;
  type: string;
  quantity: number;
  referenceType: string | null;
  referenceId: string | null;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

interface IRaceOutcome {
  status: number;
  body: Record<string, unknown>;
}

interface IRacer {
  token: string;
  cartId: string;
}

describe('Concurrent oversell — two carts race for the last unit (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const customerLogin = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/customer/login').send({ email, password });
    return (body as ITokenResponse).accessToken;
  };

  // A fresh registered customer per call — the second racer (the first is the
  // seeded `customer@example.com`).
  const registerCustomer = async (): Promise<string> => {
    const email = `oversell-${stamp}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    await server().post('/api/auth/customer/register').send({ email, password: CUSTOMER_PASSWORD });
    return customerLogin(email, CUSTOMER_PASSWORD);
  };

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const waitForStockRow = async (variantId: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRows(variantId)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variantId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const provisionVariant = async (label: string, onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Oversell ${label} ${stamp}`,
        slug: `e2e-oversell-${label}-${stamp}`,
        description: 'oversell-proof fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-OVRSL-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variantId = (variantRes.body as { id: number }).id;

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
      .send({ quantity: onHand });
    expect(receiveRes.status).toBe(HttpStatus.OK);

    return variantId;
  };

  const openCart = async (token: string): Promise<string> => {
    const { body } = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ currency: 'USD' });
    return (body as ICartBody).id;
  };

  const warehouseLevel = async (variantId: number): Promise<IStockLevelBody> => {
    const { body } = await server().get(`/api/inventory/variants/${variantId}/stock`);
    const stock = body as IVariantStockBody;
    return (
      stock.locations.find((l) => l.stockLocationId === DEFAULT_WAREHOUSE) ?? {
        stockLocationId: DEFAULT_WAREHOUSE,
        quantityOnHand: 0,
        quantityAllocated: 0,
        quantityReserved: 0,
        available: 0,
      }
    );
  };

  const listMovements = async (variantId: number): Promise<IMovementBody[]> => {
    const { body } = await server()
      .get(`/api/inventory/variants/${variantId}/movements`)
      .set('Authorization', adminAuth);
    return (body as IPageBody<IMovementBody>).items;
  };

  // Fire one add-to-cart and capture its outcome WITHOUT throwing on a non-2xx —
  // the loser's 409 is an expected outcome, not an error. Returning a plain object
  // (not the live supertest Test) keeps the two in-flight requests independent.
  const addLine = async (
    racer: IRacer,
    variantId: number,
    quantity: number,
  ): Promise<IRaceOutcome> => {
    const res = await server()
      .post(`/api/cart/${racer.cartId}/lines`)
      .set('Authorization', `Bearer ${racer.token}`)
      .send({ variantId, quantity });
    return { status: res.status, body: res.body as Record<string, unknown> };
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
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  describe('the race, then the winner places', () => {
    let variantId: number;
    let winner: IRacer;
    let loser: IRacer;
    let order: IOrderBody;

    beforeAll(async () => {
      variantId = await provisionVariant('place', 1);
    }, timeout);

    it('exactly one racer wins the add; the loser gets 409 INVENTORY_OUT_OF_STOCK / available 0', async () => {
      const racerOne: IRacer = {
        token: await customerLogin(CUSTOMER_EMAIL, CUSTOMER_PASSWORD),
        cartId: '',
      };
      const racerTwo: IRacer = { token: await registerCustomer(), cartId: '' };
      racerOne.cartId = await openCart(racerOne.token);
      racerTwo.cartId = await openCart(racerTwo.token);
      const racers = [racerOne, racerTwo];

      // Both adds in flight at once — true contention on the single stock_level row.
      const outcomes = await Promise.all(racers.map((racer) => addLine(racer, variantId, 1)));

      // Winner-agnostic: sum the outcomes, never assume which index won.
      const wins = outcomes.filter((o) => o.status === (HttpStatus.OK as number));
      const conflicts = outcomes.filter((o) => o.status === (HttpStatus.CONFLICT as number));
      expect(wins).toHaveLength(1);
      expect(conflicts).toHaveLength(1);

      const conflict = conflicts[0];
      expect(conflict.body.code).toBe('INVENTORY_OUT_OF_STOCK');
      expect((conflict.body.details as { available: number }).available).toBe(0);

      const winnerIndex = outcomes.findIndex((o) => o.status === (HttpStatus.OK as number));
      winner = racers[winnerIndex];
      loser = racers[1 - winnerIndex];

      // The single unit is held by the winner: on-hand untouched, available 0.
      const level = await warehouseLevel(variantId);
      expect(level.quantityOnHand).toBe(1);
      expect(level.quantityReserved).toBe(1);
      expect(level.available).toBe(0);
    });

    it('the loser retrying still gets 409; stock stays available 0 / reserved 1', async () => {
      const retry = await addLine(loser, variantId, 1);
      expect(retry.status).toBe(HttpStatus.CONFLICT);
      expect(retry.body.code).toBe('INVENTORY_OUT_OF_STOCK');
      expect((retry.body.details as { available: number }).available).toBe(0);

      const level = await warehouseLevel(variantId);
      expect(level.available).toBe(0);
      expect(level.quantityReserved).toBe(1);
    });

    it('the winner places → 201; reserved becomes allocated; exactly one allocation row; no negative counters', async () => {
      const place = await server()
        .post(`/api/cart/${winner.cartId}/place`)
        .set('Authorization', `Bearer ${winner.token}`)
        .set('Idempotency-Key', `oversell-${stamp}-place`)
        .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });

      expect(place.status).toBe(HttpStatus.CREATED);
      order = place.body as IOrderBody;

      const level = await warehouseLevel(variantId);
      expect(level.quantityOnHand).toBe(1);
      expect(level.quantityAllocated).toBe(1);
      expect(level.quantityReserved).toBe(0);
      expect(level.available).toBe(0);
      // No counter ever goes negative — the oversell hole would surface here.
      expect(level.quantityOnHand).toBeGreaterThanOrEqual(0);
      expect(level.quantityAllocated).toBeGreaterThanOrEqual(0);
      expect(level.quantityReserved).toBeGreaterThanOrEqual(0);
      expect(level.available).toBeGreaterThanOrEqual(0);

      const allocations = (await listMovements(variantId)).filter((m) => m.type === 'allocation');
      expect(allocations).toHaveLength(1);
      expect(allocations[0].quantity).toBe(-1);
      expect(allocations[0].referenceType).toBe('order');
      expect(allocations[0].referenceId).toBe(String(order.id));
    });

    it('consistency sweep: the ledger holds exactly the receipt + the allocation, totals stable', async () => {
      const movements = await listMovements(variantId);
      // The loser's failed add left NO orphaned hold and NO stray ledger row: the
      // variant's whole timeline is exactly the provisioning receipt (+1) and the
      // winner's allocation (−1). A reserve writes no movement, so the winner's
      // successful hold is invisible here too — only its allocation survives.
      const receipts = movements.filter((m) => m.type === 'receipt');
      const allocations = movements.filter((m) => m.type === 'allocation');
      expect(receipts).toHaveLength(1);
      expect(receipts[0].quantity).toBe(1);
      expect(allocations).toHaveLength(1);
      expect(movements).toHaveLength(2);

      const level = await warehouseLevel(variantId);
      expect(level.quantityOnHand).toBe(1);
      expect(level.quantityAllocated).toBe(1);
      expect(level.quantityReserved).toBe(0);
      expect(level.available).toBe(0);
    });
  });

  // Second act: the release path under the same contention. Instead of placing,
  // the winner REMOVES its line (release) and the loser can then reserve the freed
  // unit. A separate fixture keeps it independent of the place scenario above.
  describe('release under contention frees the unit for the loser', () => {
    let variantId: number;

    it('one racer wins, frees the unit on remove, and the other can then reserve it', async () => {
      variantId = await provisionVariant('release', 1);

      const racerOne: IRacer = {
        token: await customerLogin(CUSTOMER_EMAIL, CUSTOMER_PASSWORD),
        cartId: '',
      };
      const racerTwo: IRacer = { token: await registerCustomer(), cartId: '' };
      racerOne.cartId = await openCart(racerOne.token);
      racerTwo.cartId = await openCart(racerTwo.token);
      const racers = [racerOne, racerTwo];

      const outcomes = await Promise.all(racers.map((racer) => addLine(racer, variantId, 1)));
      expect(outcomes.filter((o) => o.status === (HttpStatus.OK as number))).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === (HttpStatus.CONFLICT as number))).toHaveLength(1);

      const winnerIndex = outcomes.findIndex((o) => o.status === (HttpStatus.OK as number));
      const winner = racers[winnerIndex];
      const loser = racers[1 - winnerIndex];

      // The loser still cannot reserve while the winner holds the unit.
      const blocked = await addLine(loser, variantId, 1);
      expect(blocked.status).toBe(HttpStatus.CONFLICT);

      // The winner abandons its line → the unit is released.
      const winnerCart = await server()
        .get(`/api/cart/${winner.cartId}`)
        .set('Authorization', `Bearer ${winner.token}`);
      const winnerLineId = (winnerCart.body as { lines: { id: number }[] }).lines[0].id;
      const remove = await server()
        .delete(`/api/cart/${winner.cartId}/lines/${winnerLineId}`)
        .set('Authorization', `Bearer ${winner.token}`);
      expect(remove.status).toBe(HttpStatus.OK);
      expect((await warehouseLevel(variantId)).available).toBe(1);

      // Now the loser CAN reserve the freed unit.
      const retry = await addLine(loser, variantId, 1);
      expect(retry.status).toBe(HttpStatus.OK);
      const level = await warehouseLevel(variantId);
      expect(level.quantityReserved).toBe(1);
      expect(level.available).toBe(0);
    });
  });
});
