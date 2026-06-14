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

// The cart reserve/release path end-to-end (ADR-030). Add-to-Cart and
// Change-Quantity reserve the line's ABSOLUTE target quantity against
// `inventory.reservation.reserve` BEFORE the cart is saved; Remove-from-Cart
// releases the hold AFTER save, best-effort. There is deliberately no reservation
// read API, so every hold is observed indirectly through the public stock read:
// while a hold is active `totalAvailable` drops but `totalOnHand` is untouched
// (a reservation never moves on-hand — only allocation/receive/adjust do).
//
// Self-provisioned, disjoint fixtures: this suite registers its OWN priced +
// published variants and `receive`s exactly the stock each scenario needs, so it
// never burns the shared seeded variants 1-4 the other suites read. The slug/SKU
// family is `e2e-cart-rr-*` and each variant gets its own product.
//
// Out of scope (a deliberate descope, recorded in the implementation doc): a
// cart-*abandonment* release-all scenario is NOT testable end-to-end — no
// abandonment producer exists in the system yet (the purge flow that flips
// `active → abandoned` belongs to a later capability). The release-all-by-cart
// codepath is unit-locked inventory-side instead (`release-reservation.use-case.spec.ts`).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';

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

interface ICartLineBody {
  id: number;
  variantId: number;
  quantity: number;
}

interface ICartBody {
  id: string;
  status: string;
  lines: ICartLineBody[];
}

interface IOutOfStockBody {
  statusCode: number;
  code?: string;
  details?: { available?: number };
}

describe('Cart reserve / release through the public stock read (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let customerToken: string;

  // Provisioned in beforeAll: variant A (on-hand 10) and variant B (on-hand 10).
  let variantA: number;
  let variantB: number;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const customerLogin = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/customer/login').send({ email, password });
    return (body as ITokenResponse).accessToken;
  };

  // TIMESTAMP(0) rounding on `price.valid_from`: a freshly-set immediate price can
  // round *up* one second into the future, which both the publish precondition and
  // the Add-to-Cart price snapshot (`asOf = now`) would read as "no active price".
  // Waiting just over a second lets that rounded second elapse.
  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  // Poll the DB until the catalog.variant.created consumer has created the zeroed
  // stock_level row. Receiving before the consumer runs could race a duplicate
  // INSERT on the UNIQUE (variant_id, stock_location_id) — the established
  // auto-init convention (inventory-receive-and-adjust.e2e-spec.ts).
  const waitForStockRow = async (variantId: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRows(variantId)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variantId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  // Register a fresh product + variant + USD price, publish it, wait for auto-init,
  // then receive `onHand` at default-warehouse. Returns the new variant id.
  const provisionVariant = async (label: string, onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Cart RR ${label} ${stamp}`,
        slug: `e2e-cart-rr-${label}-${stamp}`,
        description: 'reserve/release fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-CARTRR-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

  const readStock = async (variantId: number): Promise<IVariantStockBody> => {
    const { body } = await server().get(`/api/inventory/variants/${variantId}/stock`);
    return body as IVariantStockBody;
  };

  // The default-warehouse slice of a variant's availability (the only location
  // this suite stocks). Falls back to a zeroed level if the row is absent.
  const warehouseLevel = async (variantId: number): Promise<IStockLevelBody> => {
    const stock = await readStock(variantId);
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

  const openCart = async (token: string): Promise<string> => {
    const { body } = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ currency: 'USD' });
    return (body as ICartBody).id;
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

    variantA = await provisionVariant('a', 10);
    variantB = await provisionVariant('b', 10);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  describe('single-line reserve / re-reserve / release lifecycle', () => {
    let cartId: string;
    let lineId: number;

    it('starts from on-hand 10, available 10', async () => {
      const stock = await readStock(variantA);
      expect(stock.totalOnHand).toBe(10);
      expect(stock.totalAvailable).toBe(10);
    });

    it('adds qty 2 → 200, on-hand stays 10 while available drops to 8 (reserve)', async () => {
      cartId = await openCart(customerToken);

      const add = await server()
        .post(`/api/cart/${cartId}/lines`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ variantId: variantA, quantity: 2 });

      // Add-to-Cart returns 200 (the gateway route is @HttpCode(OK)), not 201.
      expect(add.status).toBe(HttpStatus.OK);
      lineId = (add.body as ICartBody).lines[0].id;

      const level = await warehouseLevel(variantA);
      expect(level.quantityOnHand).toBe(10);
      expect(level.quantityReserved).toBe(2);
      expect(level.available).toBe(8);
    });

    it('changes the line up to 5 → available 5 (absolute re-reserve)', async () => {
      const change = await server()
        .patch(`/api/cart/${cartId}/lines/${lineId}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ quantity: 5 });
      expect(change.status).toBe(HttpStatus.OK);

      const level = await warehouseLevel(variantA);
      expect(level.quantityOnHand).toBe(10);
      expect(level.quantityReserved).toBe(5);
      expect(level.available).toBe(5);
    });

    it('changes the line down to 1 → available 9 (absolute re-reserve, not a delta)', async () => {
      const change = await server()
        .patch(`/api/cart/${cartId}/lines/${lineId}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ quantity: 1 });
      expect(change.status).toBe(HttpStatus.OK);

      const level = await warehouseLevel(variantA);
      expect(level.quantityReserved).toBe(1);
      expect(level.available).toBe(9);
    });

    it('removes the line → available back to 10 (release)', async () => {
      const remove = await server()
        .delete(`/api/cart/${cartId}/lines/${lineId}`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(remove.status).toBe(HttpStatus.OK);

      const level = await warehouseLevel(variantA);
      expect(level.quantityOnHand).toBe(10);
      expect(level.quantityReserved).toBe(0);
      expect(level.available).toBe(10);
    });
  });

  describe('two-variant cart: removing one line releases only that variant', () => {
    let cartId: string;
    let lineA: number;
    let lineB: number;

    it('holds variant A (qty 2) and variant B (qty 3) in one cart', async () => {
      cartId = await openCart(customerToken);

      const addA = await server()
        .post(`/api/cart/${cartId}/lines`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ variantId: variantA, quantity: 2 });
      expect(addA.status).toBe(HttpStatus.OK);
      lineA = (addA.body as ICartBody).lines.find((l) => l.variantId === variantA)!.id;

      const addB = await server()
        .post(`/api/cart/${cartId}/lines`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ variantId: variantB, quantity: 3 });
      expect(addB.status).toBe(HttpStatus.OK);
      lineB = (addB.body as ICartBody).lines.find((l) => l.variantId === variantB)!.id;

      expect((await warehouseLevel(variantA)).available).toBe(8);
      expect((await warehouseLevel(variantB)).available).toBe(7);
    });

    it('removing the A line frees only A; B stays held', async () => {
      const remove = await server()
        .delete(`/api/cart/${cartId}/lines/${lineA}`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(remove.status).toBe(HttpStatus.OK);

      // A returns to full; B's hold is untouched (per-line release keys on the
      // line's variant, not the whole cart).
      expect((await warehouseLevel(variantA)).available).toBe(10);
      const levelB = await warehouseLevel(variantB);
      expect(levelB.quantityReserved).toBe(3);
      expect(levelB.available).toBe(7);
    });

    it('removing the B line frees B too (cart cleanup)', async () => {
      const remove = await server()
        .delete(`/api/cart/${cartId}/lines/${lineB}`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(remove.status).toBe(HttpStatus.OK);

      expect((await warehouseLevel(variantB)).available).toBe(10);
    });
  });

  describe('out-of-stock add is a 409 that leaves the cart line-less', () => {
    it('adding qty 11 against available 10 → 409 INVENTORY_OUT_OF_STOCK with available 10', async () => {
      const cartId = await openCart(customerToken);

      const add = await server()
        .post(`/api/cart/${cartId}/lines`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ variantId: variantA, quantity: 11 });

      expect(add.status).toBe(HttpStatus.CONFLICT);
      const body = add.body as IOutOfStockBody;
      expect(body.code).toBe('INVENTORY_OUT_OF_STOCK');
      expect(body.details?.available).toBe(10);

      // Reserve-before-save: a rejected reserve never mutates the cart.
      const cart = await server()
        .get(`/api/cart/${cartId}`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect((cart.body as ICartBody).lines).toEqual([]);

      // And the rejected add held nothing — available is unchanged.
      expect((await warehouseLevel(variantA)).available).toBe(10);
    });
  });
});
