import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ClientProxy,
  ClientProxyFactory,
  MicroserviceOptions,
  Transport,
} from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import {
  ICatalogVariantCreatedEvent,
  MicroserviceQueueEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { InventoryAutoInitE2ESpecDataSource } from './data-source/inventory-auto-init.e2e-spec.data-source';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';

interface ITokenResponse {
  accessToken: string;
}

interface IVariantBody {
  id: number;
  productId: number;
  sku: string;
  status: string;
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
  quantity_allocated: number;
  quantity_reserved: number;
  version: number;
}

describe('Inventory auto-init on catalog.variant.created (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;
  let inventoryPublisher: ClientProxy;

  const stamp = Date.now();
  const productSlug = `e2e-auto-init-${stamp}`;
  const sku = `E2E-AUTOINIT-${stamp}`;

  let variantId: number;

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

    inventoryPublisher = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: MicroserviceQueueEnum.INVENTORY_QUEUE,
        queueOptions: { durable: true },
      },
    });
    await inventoryPublisher.connect();

    const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

    const productResponse = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/catalog/products')
      .set('Authorization', auth)
      .send({
        name: `E2E Auto-init ${stamp}`,
        slug: productSlug,
        description: 'auto-init fixture',
      });
    const productId = (productResponse.body as { id: number }).id;

    const variantResponse = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', auth)
      .send({ sku, optionValues: { color: 'black', size: 'M' } });
    variantId = (variantResponse.body as IVariantBody).id;
  }, timeout);

  afterAll(async () => {
    await inventoryPublisher?.close();
    await apiGatewayApp?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('auto-initializes a zeroed default-warehouse stock level, observable via the inventory GET', async () => {
    const rows = await waitForRows();

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.stock_location_id).toBe(DEFAULT_WAREHOUSE);
    expect(row.quantity_on_hand).toBe(0);
    expect(row.quantity_allocated).toBe(0);
    expect(row.quantity_reserved).toBe(0);
    expect(typeof row.version).toBe('number');

    const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(
      `/api/inventory/variants/${variantId}/stock`,
    );

    expect(status).toBe(HttpStatus.OK);
    const stock = body as IVariantStockBody;
    expect(stock.variantId).toBe(variantId);
    expect(stock.totalOnHand).toBe(0);
    expect(stock.totalAvailable).toBe(0);
    expect(stock.locations).toHaveLength(1);

    const [level] = stock.locations;
    expect(level.stockLocationId).toBe(DEFAULT_WAREHOUSE);
    expect(level.quantityOnHand).toBe(0);
    expect(level.available).toBe(0);
  });

  it('is idempotent — a repeat catalog.variant.created does not duplicate the row', async () => {
    const duplicate: ICatalogVariantCreatedEvent = {
      productId: 0,
      variantId,
      sku,
      eventVersion: 'v1',
      occurredAt: new Date().toISOString(),
      correlationId: `e2e-auto-init-dup-${stamp}`,
    };
    await firstValueFrom(inventoryPublisher.emit(ROUTING_KEYS.CATALOG_VARIANT_CREATED, duplicate));

    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const rows = (await dataSource.getStockLevelRows(variantId)) as IStockLevelRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity_on_hand).toBe(0);

    const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(
      `/api/inventory/variants/${variantId}/stock`,
    );
    expect(status).toBe(HttpStatus.OK);
    expect((body as IVariantStockBody).locations).toHaveLength(1);
  });
});
