import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { InventoryAutoInitE2ESpecDataSource } from './data-source/inventory-auto-init.e2e-spec.data-source';

// Proves the stock-availability cache is invalidated **post-commit** (ADR-023):
// a Receive routes its write through `stockCache.withInvalidation(...)`, which
// awaits the commit and only then wipes the cached `VariantStockView`. The spec
// primes the cache (a read that writes the pre-receive figure back to Redis),
// receives stock, and asserts the very next read reflects the new figure — if the
// invalidation ran before the commit (or not at all), the read would serve the
// stale primed value.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';

interface ITokenResponse {
  accessToken: string;
}

interface IVariantStockBody {
  variantId: number;
  totalOnHand: number;
  totalAvailable: number;
  locations: { stockLocationId: string; quantityOnHand: number; available: number }[];
}

interface IStockLevelRow {
  stock_location_id: string;
}

describe('Inventory cache post-commit invalidation (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  const productSlug = `e2e-cache-${stamp}`;
  const sku = `E2E-CACHE-${stamp}`;

  let variantId: number;
  let adminAuth: string;

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/staff/login')
      .send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const waitForRows = async (deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    let rows = (await dataSource.getStockLevelRows(variantId)) as IStockLevelRow[];
    while (rows.length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variantId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      rows = (await dataSource.getStockLevelRows(variantId)) as IStockLevelRow[];
    }
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
      .send({ name: `E2E Cache ${stamp}`, slug: productSlug, description: 'cache fixture' });
    const productId = (productResponse.body as { id: number }).id;

    const variantResponse = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku, optionValues: { color: 'red', size: 'L' } });
    variantId = (variantResponse.body as { id: number }).id;

    await waitForRows();
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('serves the post-commit figure on the read after a Receive (invalidation runs post-commit)', async () => {
    // Prime: this read loads the pre-receive figure (0) from MySQL and writes the
    // `VariantStockView` back to Redis under ris:inventory:stock:v3:<variantId>:__all__.
    const primed = await supertest(apiGatewayApp.getHttpServer()).get(
      `/api/inventory/variants/${variantId}/stock`,
    );
    expect(primed.status).toBe(HttpStatus.OK);
    expect((primed.body as IVariantStockBody).totalAvailable).toBe(0);

    // Receive 30. The write commits, then `withInvalidation` wipes the primed key.
    const received = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/inventory/variants/${variantId}/stock/receive`)
      .set('Authorization', adminAuth)
      .send({ quantity: 30 });
    expect(received.status).toBe(HttpStatus.OK);

    // The next read is a clean miss (the primed value was invalidated) and loads
    // the post-commit 30 — not the stale primed 0.
    const afterReceive = await supertest(apiGatewayApp.getHttpServer()).get(
      `/api/inventory/variants/${variantId}/stock`,
    );
    expect(afterReceive.status).toBe(HttpStatus.OK);
    expect((afterReceive.body as IVariantStockBody).totalOnHand).toBe(30);
    expect((afterReceive.body as IVariantStockBody).totalAvailable).toBe(30);

    // A repeat read is a cache hit and returns the same body (re-primed at 30).
    const cachedRead = await supertest(apiGatewayApp.getHttpServer()).get(
      `/api/inventory/variants/${variantId}/stock`,
    );
    expect(cachedRead.body).toEqual(afterReceive.body);
  });
});
