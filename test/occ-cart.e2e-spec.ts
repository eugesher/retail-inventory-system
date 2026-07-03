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

// Optimistic concurrency on cart line writes (ADR-036). Two `PATCH /cart/:id/lines/:lineId`
// requests fire at the SAME cart line at once, each pinning the SAME `If-Match: <version>`
// precondition. The root `version` is the aggregate's OCC anchor: even a pure line edit
// bumps it, so the two writes serialise through one version-checked compare-and-swap.
// EXACTLY ONE wins (HTTP 200, version now advanced); the loser gets `409` with the uniform
// `{ code: 'VERSION_MISMATCH', details: { currentVersion } }` — an `If-Match` pin takes a
// SINGLE attempt (no silent retry), so a lost race is an immediate precondition failure the
// client can resolve by refetching and retrying against the new version.
//
// Winner-AGNOSTIC: the suite never assumes WHICH request wins — it classifies by outcome and
// asserts exactly one 200 + one 409. It reads `version` from the public `CartView`, never a
// broker side effect. Self-provisioned, disjoint fixture (`e2e-occ-cart-*`) with ample stock
// so the reserve never fails — the only contention under test is the cart version.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

interface ITokenResponse {
  accessToken: string;
}

interface ICartLineView {
  id: number;
  quantity: number;
}

interface ICartView {
  id: string;
  version: number;
  lines: ICartLineView[];
}

interface IRaceOutcome {
  status: number;
  body: Record<string, unknown>;
}

describe('OCC on cart line writes: concurrent edits resolve to one winner (e2e)', () => {
  const timeout = 60_000;

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
        name: `E2E OCC Cart ${label} ${stamp}`,
        slug: `e2e-occ-cart-${label}-${stamp}`,
        description: 'occ-cart fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-OCCCART-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variant = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variant}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1500 });
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

  // Open a cart, add the line, and return the cart id, line id, and the version the concurrent
  // PATCHes will pin. A fresh cart per race keeps the races independent.
  const openCartWithLine = async (): Promise<{
    cartId: string;
    lineId: number;
    version: number;
  }> => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    const cartId = (create.body as ICartView).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: 2 });
    expect(add.status).toBe(HttpStatus.OK);
    const cart = add.body as ICartView;
    return { cartId, lineId: cart.lines[0].id, version: cart.version };
  };

  // Fire one change-quantity with an `If-Match` pin, capturing the outcome without throwing on
  // a non-2xx (the loser's 409 is expected).
  const changeQuantity = async (
    cartId: string,
    lineId: number,
    quantity: number,
    ifMatch: number,
  ): Promise<IRaceOutcome> => {
    const res = await server()
      .patch(`/api/cart/${cartId}/lines/${lineId}`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('If-Match', String(ifMatch))
      .send({ quantity });
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

  it('two concurrent If-Match PATCHes: exactly one wins (200), the loser gets 409 VERSION_MISMATCH + currentVersion', async () => {
    const { cartId, lineId, version } = await openCartWithLine();

    // Both pin the same loaded version and ask for a different new quantity — a genuine
    // conflicting edit. Fired in the same tick so they truly race the root CAS.
    const [a, b] = await Promise.all([
      changeQuantity(cartId, lineId, 3, version),
      changeQuantity(cartId, lineId, 5, version),
    ]);
    const outcomes = [a, b];

    const wins = outcomes.filter((o) => o.status === (HttpStatus.OK as number));
    const conflicts = outcomes.filter((o) => o.status === (HttpStatus.CONFLICT as number));
    expect(wins).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    // The loser's 409 carries the uniform wire code + the current version to refetch.
    const conflict = conflicts[0];
    expect(conflict.body.code).toBe('VERSION_MISMATCH');
    const details = conflict.body.details as { currentVersion: number };
    expect(typeof details.currentVersion).toBe('number');

    // The winner advanced the version exactly once past the pinned value.
    const fresh = await server()
      .get(`/api/cart/${cartId}`)
      .set('Authorization', `Bearer ${customerToken}`);
    const cart = fresh.body as ICartView;
    expect(cart.version).toBe(version + 1);
    // The persisted quantity is the winner's target (3 or 5), never a merge of both.
    expect([3, 5]).toContain(cart.lines[0].quantity);

    // The reported currentVersion is at least the committed version — enough for the client
    // to refetch and retry.
    expect(details.currentVersion).toBeGreaterThanOrEqual(version + 1);
  });

  it('the loser recovers by refetching the current version and retrying the pin', async () => {
    const { cartId, lineId, version } = await openCartWithLine();

    // First writer wins and bumps the version.
    const winner = await changeQuantity(cartId, lineId, 4, version);
    expect(winner.status).toBe(HttpStatus.OK);

    // A stale pin (the now-superseded version) is rejected.
    const stale = await changeQuantity(cartId, lineId, 6, version);
    expect(stale.status).toBe(HttpStatus.CONFLICT);
    expect(stale.body.code).toBe('VERSION_MISMATCH');

    // Refetch the current version and retry — now it succeeds.
    const fresh = (
      await server().get(`/api/cart/${cartId}`).set('Authorization', `Bearer ${customerToken}`)
    ).body as ICartView;
    const retry = await changeQuantity(cartId, lineId, 6, fresh.version);
    expect(retry.status).toBe(HttpStatus.OK);
    expect((retry.body as unknown as ICartView).lines[0].quantity).toBe(6);
  });
});
