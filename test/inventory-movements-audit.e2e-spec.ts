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

// The stock-movement audit ledger end-to-end (ADR-030 §2). One variant is driven
// through every counter-changing operation over HTTP and the
// `GET /api/inventory/variants/:variantId/movements` read is asserted to hold the
// exact newest-first timeline, with the right types, signs, reason codes,
// reference pairs, and actor ids — plus the filter / paging / permission contract.
//
// The full flow (each step a real gateway request):
//   receive 10  → adjust −2 (cycle-count) → transfer 3 to backup-store
//   (warehouse staff, inventory:adjust / :transfer)
//   then, as the seeded customer: add 2 to a cart → remove the line (release) →
//   place a fresh 1-line cart (allocation).
//
// The audit read is per-variant and spans locations, so BOTH transfer legs appear
// on the same variant timeline (−3 debited at the source, +3 credited at the
// destination — there is no by-location ledger filter). A reservation writes NO
// ledger row, so the cart ADD is invisible here; only the release and the
// allocation surface. Staff-driven rows carry the staff `actorId`; the cart-driven
// release + the place-driven allocation are system rows (`actorId: null`).
//
// Note on the by-reservation-id manual release: that endpoint is exercised in the
// `http/inventory.http` flow and the inventory unit specs. There is no HTTP source
// for a reservation id in-suite (no reservation read API), so the same `release`
// ledger row is produced here via the cart Remove route, which travels the
// identical release codepath (reason `cart-removed`).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const WAREHOUSE_EMAIL = 'warehouse@example.com';
const WAREHOUSE_PASSWORD = 'warehouse1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
// The seeded warehouse-staff user id (scripts/test-db-seed.ts) — the `actorId`
// the gateway folds from `@CurrentUser().id` onto every staff-driven movement.
const WAREHOUSE_STAFF_ID = '00000000-0000-4000-a000-000000000004';
const DEFAULT_WAREHOUSE = 'default-warehouse';
const BACKUP_STORE = 'backup-store';

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
  lines: { id: number; variantId: number }[];
}

interface IOrderBody {
  id: number;
}

interface IMovementBody {
  id: number;
  variantId: number;
  stockLocationId: string;
  type: string;
  quantity: number;
  reasonCode: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actorId: string | null;
  occurredAt: string;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Inventory stock-movement audit ledger (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let warehouseAuth: string;
  let customerToken: string;

  let variantId: number;
  let orderId: number;
  let transferReferenceId: string;

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

  const waitForStockRow = async (id: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRows(id)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${id}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  // Register product + variant + price + publish (NO receive — the receipt is the
  // first explicit ledger row this suite asserts). Waits for auto-init so the
  // subsequent receive does not race a duplicate INSERT.
  const provisionPricedVariant = async (): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Audit ${stamp}`,
        slug: `e2e-audit-${stamp}`,
        description: 'movements-audit fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-AUDIT-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const newVariantId = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${newVariantId}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });
    expect(priceRes.status).toBe(HttpStatus.CREATED);

    await settleTimestampRounding();

    const publishRes = await server()
      .post(`/api/catalog/products/${productId}/publish`)
      .set('Authorization', adminAuth);
    expect(publishRes.status).toBe(HttpStatus.OK);

    await waitForStockRow(newVariantId);
    return newVariantId;
  };

  const listMovements = async (
    query: Record<string, string | number> = {},
    auth: string = adminAuth,
  ): Promise<IPageBody<IMovementBody>> => {
    const { body } = await server()
      .get(`/api/inventory/variants/${variantId}/movements`)
      .query(query)
      .set('Authorization', auth);
    return body as IPageBody<IMovementBody>;
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
    warehouseAuth = await bearer(WAREHOUSE_EMAIL, WAREHOUSE_PASSWORD);
    customerToken = await customerLogin(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

    variantId = await provisionPricedVariant();
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('drives the full receive → adjust → transfer → cart-add → cart-remove → place flow', async () => {
    // receive 10 (warehouse staff) → on-hand 10
    const receive = await server()
      .post(`/api/inventory/variants/${variantId}/stock/receive`)
      .set('Authorization', warehouseAuth)
      .send({ quantity: 10 });
    expect(receive.status).toBe(HttpStatus.OK);

    // adjust −2 with a reason → on-hand 8
    const adjust = await server()
      .post(`/api/inventory/variants/${variantId}/stock/adjust`)
      .set('Authorization', warehouseAuth)
      .send({ quantityDelta: -2, reasonCode: 'cycle-count' });
    expect(adjust.status).toBe(HttpStatus.OK);

    // transfer 3 to backup-store → source on-hand 5, destination on-hand 3
    const transfer = await server()
      .post(`/api/inventory/variants/${variantId}/stock/transfer`)
      .set('Authorization', warehouseAuth)
      .send({ fromLocationId: DEFAULT_WAREHOUSE, toLocationId: BACKUP_STORE, quantity: 3 });
    expect(transfer.status).toBe(HttpStatus.OK);

    // customer adds 2 to a cart (reserve — NO ledger row), then removes the line
    // (release — a `cart-removed` ledger row).
    const cart = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    const cartId = (cart.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: 2 });
    expect(add.status).toBe(HttpStatus.OK);
    const lineId = (add.body as ICartBody).lines.find((l) => l.variantId === variantId)!.id;

    const remove = await server()
      .delete(`/api/cart/${cartId}/lines/${lineId}`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(remove.status).toBe(HttpStatus.OK);

    // place a fresh 1-line cart (reserve 1 → allocate 1 — an `allocation` row).
    const placeCart = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    const placeCartId = (placeCart.body as ICartBody).id;

    const addPlace = await server()
      .post(`/api/cart/${placeCartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: 1 });
    expect(addPlace.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${placeCartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `audit-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    orderId = (place.body as IOrderBody).id;
  });

  it('returns the exact newest-first timeline with the right types, signs, references, and actors', async () => {
    const page = await listMovements();
    expect(page.total).toBe(6);
    expect(page.items).toHaveLength(6);

    const items = page.items;

    // [0] allocation (−1), order reference, system actor.
    expect(items[0].type).toBe('allocation');
    expect(items[0].quantity).toBe(-1);
    expect(items[0].referenceType).toBe('order');
    expect(items[0].referenceId).toBe(String(orderId));
    expect(items[0].actorId).toBeNull();

    // [1] release (−2), cart reference, reason cart-removed, system actor.
    expect(items[1].type).toBe('release');
    expect(items[1].quantity).toBe(-2);
    expect(items[1].referenceType).toBe('cart');
    expect(items[1].reasonCode).toBe('cart-removed');
    expect(items[1].actorId).toBeNull();

    // [2] + [3] the two transfer legs (one +3 transfer-in, one −3 transfer-out),
    // both `adjustment` type, both `transfer` reference sharing one referenceId,
    // both attributed to the warehouse staff. Order between the two is not
    // asserted (same transaction, same occurredAt) — match them by reason.
    const transferLegs = [items[2], items[3]];
    transferLegs.forEach((leg) => {
      expect(leg.type).toBe('adjustment');
      expect(leg.referenceType).toBe('transfer');
      expect(leg.actorId).toBe(WAREHOUSE_STAFF_ID);
    });
    const transferIn = transferLegs.find((l) => l.reasonCode === 'transfer-in')!;
    const transferOut = transferLegs.find((l) => l.reasonCode === 'transfer-out')!;
    expect(transferIn).toBeDefined();
    expect(transferOut).toBeDefined();
    expect(transferIn.quantity).toBe(3);
    expect(transferIn.stockLocationId).toBe(BACKUP_STORE);
    expect(transferOut.quantity).toBe(-3);
    expect(transferOut.stockLocationId).toBe(DEFAULT_WAREHOUSE);
    // The two legs are one transfer — same referenceId.
    expect(transferIn.referenceId).toBe(transferOut.referenceId);
    transferReferenceId = transferIn.referenceId!;

    // [4] adjustment (−2), operator reason cycle-count, warehouse actor.
    expect(items[4].type).toBe('adjustment');
    expect(items[4].quantity).toBe(-2);
    expect(items[4].reasonCode).toBe('cycle-count');
    expect(items[4].referenceType).toBeNull();
    expect(items[4].actorId).toBe(WAREHOUSE_STAFF_ID);

    // [5] receipt (+10), no reference, warehouse actor.
    expect(items[5].type).toBe('receipt');
    expect(items[5].quantity).toBe(10);
    expect(items[5].referenceType).toBeNull();
    expect(items[5].reasonCode).toBeNull();
    expect(items[5].actorId).toBe(WAREHOUSE_STAFF_ID);
  });

  it('filters by type: ?type=adjustment narrows to the operator adjust + the two transfer legs', async () => {
    const page = await listMovements({ type: 'adjustment' });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(3);
    page.items.forEach((m) => expect(m.type).toBe('adjustment'));
    // The two transfer legs are in this set (same shared referenceId).
    const transferRows = page.items.filter((m) => m.referenceId === transferReferenceId);
    expect(transferRows).toHaveLength(2);
  });

  it('bounds the window with ?from / ?to', async () => {
    const farPast = '2000-01-01T00:00:00.000Z';
    const farFuture = '2999-01-01T00:00:00.000Z';

    // A window that brackets the whole flow returns every row.
    const within = await listMovements({ from: farPast, to: farFuture });
    expect(within.total).toBe(6);

    // An upper bound before any movement → empty.
    const beforeAll = await listMovements({ to: farPast });
    expect(beforeAll.total).toBe(0);
    expect(beforeAll.items).toEqual([]);

    // A lower bound after every movement → empty.
    const afterAll = await listMovements({ from: farFuture });
    expect(afterAll.total).toBe(0);
    expect(afterAll.items).toEqual([]);
  });

  it('pages the same set: pageSize=2 walks three disjoint pages of a stable total', async () => {
    const pageOne = await listMovements({ page: 1, pageSize: 2 });
    const pageTwo = await listMovements({ page: 2, pageSize: 2 });
    const pageThree = await listMovements({ page: 3, pageSize: 2 });

    expect(pageOne.total).toBe(6);
    expect(pageTwo.total).toBe(6);
    expect(pageThree.total).toBe(6);
    expect(pageOne.size).toBe(2);

    expect(pageOne.items).toHaveLength(2);
    expect(pageTwo.items).toHaveLength(2);
    expect(pageThree.items).toHaveLength(2);

    // The three pages are disjoint and together cover all six rows.
    const ids = new Set([
      ...pageOne.items.map((m) => m.id),
      ...pageTwo.items.map((m) => m.id),
      ...pageThree.items.map((m) => m.id),
    ]);
    expect(ids.size).toBe(6);
  });

  it('gates the audit read: 401 without a token, 403 with a customer token', async () => {
    const anon = await server().get(`/api/inventory/variants/${variantId}/movements`);
    expect(anon.status).toBe(HttpStatus.UNAUTHORIZED);

    const asCustomer = await server()
      .get(`/api/inventory/variants/${variantId}/movements`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(asCustomer.status).toBe(HttpStatus.FORBIDDEN);
  });
});
