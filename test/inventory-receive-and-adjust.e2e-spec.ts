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
const CATALOG_EMAIL = 'catalog@example.com';
const CATALOG_PASSWORD = 'catalog1234';
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
  version: number;
  updatedAt: string | null;
}

interface IVariantStockBody {
  variantId: number;
  totalOnHand: number;
  totalAvailable: number;
  locations: IStockLevelBody[];
}

interface IStockLevelRow {
  stock_location_id: string;
  quantity_on_hand: number;
}

describe('Inventory receive + adjust write path (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  const productSlug = `e2e-receive-adjust-${stamp}`;
  const sku = `E2E-RCVADJ-${stamp}`;

  let variantId: number;
  let adminAuth: string;
  let catalogAuth: string;

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/staff/login')
      .send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const waitForRows = async (deadlineMs = 20_000): Promise<IStockLevelRow[]> => {
    const start = Date.now();
    let rows = (await dataSource.getStockLevelRows(variantId)) as IStockLevelRow[];
    while (rows.length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variantId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      rows = (await dataSource.getStockLevelRows(variantId)) as IStockLevelRow[];
    }
    return rows;
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
    catalogAuth = await bearer(CATALOG_EMAIL, CATALOG_PASSWORD);

    const productResponse = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Receive/Adjust ${stamp}`,
        slug: productSlug,
        description: 'rcv/adj fixture',
      });
    const productId = (productResponse.body as { id: number }).id;

    const variantResponse = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku, optionValues: { color: 'black', size: 'M' } });
    variantId = (variantResponse.body as { id: number }).id;
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('runs the full auto-init → receive 50 → adjust −3 → read 47 → adjust −100 (409) → 403 flow', async () => {
    await waitForRows();
    const initial = await supertest(apiGatewayApp.getHttpServer()).get(
      `/api/inventory/variants/${variantId}/stock`,
    );
    expect(initial.status).toBe(HttpStatus.OK);
    expect((initial.body as IVariantStockBody).totalOnHand).toBe(0);

    const received = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/inventory/variants/${variantId}/stock/receive`)
      .set('Authorization', adminAuth)
      .send({ quantity: 50 });
    expect(received.status).toBe(HttpStatus.OK);
    const receivedLevel = received.body as IStockLevelBody;
    expect(receivedLevel.stockLocationId).toBe(DEFAULT_WAREHOUSE);
    expect(receivedLevel.quantityOnHand).toBe(50);
    expect(receivedLevel.available).toBe(50);

    const adjusted = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/inventory/variants/${variantId}/stock/adjust`)
      .set('Authorization', adminAuth)
      .send({ quantityDelta: -3, reasonCode: 'damaged' });
    expect(adjusted.status).toBe(HttpStatus.OK);
    const adjustedLevel = adjusted.body as IStockLevelBody;
    expect(adjustedLevel.quantityOnHand).toBe(47);
    expect(adjustedLevel.available).toBe(47);

    const firstRead = await supertest(apiGatewayApp.getHttpServer()).get(
      `/api/inventory/variants/${variantId}/stock`,
    );
    const secondRead = await supertest(apiGatewayApp.getHttpServer()).get(
      `/api/inventory/variants/${variantId}/stock`,
    );
    expect(firstRead.status).toBe(HttpStatus.OK);
    expect((firstRead.body as IVariantStockBody).totalAvailable).toBe(47);
    expect(secondRead.body).toEqual(firstRead.body);

    const belowZero = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/inventory/variants/${variantId}/stock/adjust`)
      .set('Authorization', adminAuth)
      .send({ quantityDelta: -100, reasonCode: 'damaged' });
    expect(belowZero.status).toBe(HttpStatus.CONFLICT);

    const afterReject = await supertest(apiGatewayApp.getHttpServer()).get(
      `/api/inventory/variants/${variantId}/stock`,
    );
    expect((afterReject.body as IVariantStockBody).totalOnHand).toBe(47);
  });

  it('rejects receive/adjust without the inventory:adjust permission (403)', async () => {
    const receive = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/inventory/variants/${variantId}/stock/receive`)
      .set('Authorization', catalogAuth)
      .send({ quantity: 1 });
    expect(receive.status).toBe(HttpStatus.FORBIDDEN);

    const adjust = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/inventory/variants/${variantId}/stock/adjust`)
      .set('Authorization', catalogAuth)
      .send({ quantityDelta: -1, reasonCode: 'damaged' });
    expect(adjust.status).toBe(HttpStatus.FORBIDDEN);
  });

  it('rejects an adjust with no reasonCode at the gateway edge (400)', async () => {
    const { status } = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/inventory/variants/${variantId}/stock/adjust`)
      .set('Authorization', adminAuth)
      .send({ quantityDelta: -1 });
    expect(status).toBe(HttpStatus.BAD_REQUEST);
  });
});
