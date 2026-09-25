import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { InventoryAutoInitE2ESpecDataSource } from './data-source/inventory-auto-init.e2e-spec.data-source';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';

const CONCURRENCY = 20;

const BULK_CONCURRENCY = 50;
const BULK_SEED = 7;

interface ITokenResponse {
  accessToken: string;
}

interface IStockLevelRow {
  stock_location_id: string;
  quantity_on_hand: number;
}

describe('Inventory write concurrency — optimistic lost-update protection (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  const productSlug = `e2e-concurrency-${stamp}`;
  const sku = `E2E-CONC-${stamp}`;

  let variantId: number;
  let adminAuth: string;

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/staff/login')
      .send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ECONNABORTED']);
  const writeWithRetry = async (
    path: string,
    body: Record<string, unknown>,
    maxTries = 40,
  ): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxTries; attempt++) {
      try {
        const res = await supertest(apiGatewayApp.getHttpServer())
          .post(path)
          .set('Authorization', adminAuth)
          .send(body);
        if (res.status === (HttpStatus.OK as number)) {
          return;
        }
        if (res.status === (HttpStatus.CONFLICT as number)) {
          continue;
        }
        throw new Error(`Unexpected ${res.status} for ${path}: ${JSON.stringify(res.body)}`);
      } catch (error) {
        lastError = error;
        const code = (error as { code?: string }).code;
        if (code && TRANSIENT_NET_CODES.has(code)) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Exhausted client retries for ${path}: ${String(lastError)}`);
  };

  const onHand = async (): Promise<number> => {
    const rows = (await dataSource.getStockLevelRows(variantId)) as IStockLevelRow[];
    const row = rows.find((r) => r.stock_location_id === DEFAULT_WAREHOUSE);
    return row ? Number(row.quantity_on_hand) : 0;
  };

  const waitForRow = async (deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRows(variantId)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variantId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const onHandOf = async (variant: number): Promise<number> => {
    const rows = (await dataSource.getStockLevelRows(variant)) as IStockLevelRow[];
    const row = rows.find((r) => r.stock_location_id === DEFAULT_WAREHOUSE);
    return row ? Number(row.quantity_on_hand) : 0;
  };

  const waitForRowOf = async (variant: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRows(variant)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variant}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const countReceiptMovements = async (variant: number): Promise<number> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .get(`/api/inventory/variants/${variant}/movements?type=receipt&pageSize=100`)
      .set('Authorization', adminAuth);
    return (body as { items: { type: string }[] }).items.length;
  };

  const provisionFreshVariant = async (label: string): Promise<number> => {
    const productResponse = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Concurrency ${label} ${stamp}`,
        slug: `e2e-concurrency-${label}-${stamp}`,
        description: 'concurrency fixture',
      });
    const productId = (productResponse.body as { id: number }).id;

    const variantResponse = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-CONC-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const freshVariantId = (variantResponse.body as { id: number }).id;

    await waitForRowOf(freshVariantId);
    return freshVariantId;
  };

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

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

    const productResponse = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Concurrency ${stamp}`,
        slug: productSlug,
        description: 'concurrency fixture',
      });
    const productId = (productResponse.body as { id: number }).id;

    const variantResponse = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku, optionValues: { color: 'black', size: 'M' } });
    variantId = (variantResponse.body as { id: number }).id;

    await waitForRow();
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it(
    'preserves every concurrent receive (+1) — no lost updates',
    async () => {
      expect(await onHand()).toBe(0);

      const receivePath = `/api/inventory/variants/${variantId}/stock/receive`;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, () => writeWithRetry(receivePath, { quantity: 1 })),
      );

      expect(await onHand()).toBe(CONCURRENCY);
    },
    timeout,
  );

  it(
    'preserves every concurrent adjust (−1) — drains back to zero exactly',
    async () => {
      expect(await onHand()).toBe(CONCURRENCY);

      const adjustPath = `/api/inventory/variants/${variantId}/stock/adjust`;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          writeWithRetry(adjustPath, { quantityDelta: -1, reasonCode: 'cycle-count' }),
        ),
      );

      expect(await onHand()).toBe(0);
    },
    timeout,
  );

  describe(`${BULK_CONCURRENCY} parallel receives converge with no lost updates`, () => {
    let bulkVariantId: number;

    beforeAll(async () => {
      bulkVariantId = await provisionFreshVariant('bulk');

      await writeWithRetry(`/api/inventory/variants/${bulkVariantId}/stock/receive`, {
        quantity: BULK_SEED,
      });
      expect(await onHandOf(bulkVariantId)).toBe(BULK_SEED);
    }, timeout);

    it(
      `final on-hand is exactly seed + ${BULK_CONCURRENCY}, and every write left a receipt movement`,
      async () => {
        const receiptsBefore = await countReceiptMovements(bulkVariantId);

        const receivePath = `/api/inventory/variants/${bulkVariantId}/stock/receive`;
        await Promise.all(
          Array.from({ length: BULK_CONCURRENCY }, () =>
            writeWithRetry(receivePath, { quantity: 1 }),
          ),
        );

        expect(await onHandOf(bulkVariantId)).toBe(BULK_SEED + BULK_CONCURRENCY);

        const receiptsAfter = await countReceiptMovements(bulkVariantId);
        expect(receiptsAfter - receiptsBefore).toBe(BULK_CONCURRENCY);
      },
      timeout,
    );
  });
});
