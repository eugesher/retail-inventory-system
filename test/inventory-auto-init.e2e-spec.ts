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

// The cross-service auto-init flow end-to-end: a catalog variant is created over
// HTTP → the catalog microservice persists it and emits `catalog.variant.created`
// onto `inventory_queue` (producer-targets-consumer-queue) → the inventory
// microservice's `CatalogEventsConsumer` auto-initializes a zeroed `stock_level`
// row at `default-warehouse` → the figure is observable via the public inventory
// GET. A repeat event is a no-op (idempotent — no duplicate row).
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

  // A fresh slug/sku each run so the flow stays idempotent under
  // `yarn test:e2e:run` against an already-seeded DB.
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

  // Polls the database directly until the consumer has created the row. Reading
  // over HTTP first would cache a `locations: []` answer (the read path does not
  // invalidate), so the DB poll is the gate before any HTTP assertion.
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

    // A direct publisher onto `inventory_queue` to re-emit a synthetic duplicate
    // event for the idempotency assertion (the notification e2e pattern).
    inventoryPublisher = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: MicroserviceQueueEnum.INVENTORY_QUEUE,
        queueOptions: { durable: true },
      },
    });
    await inventoryPublisher.connect();

    // Create the product + variant over HTTP; adding the variant is what emits
    // `catalog.variant.created` and triggers the inventory auto-init consumer.
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

    // Exactly one row, zeroed, at the default warehouse. `version` is a
    // TypeORM `@VersionColumn()` — it starts at 1 on the INSERT path (not the
    // domain's in-memory 0), so the meaningful zeroed invariant is the three
    // quantity columns, not the optimistic-lock token's starting value.
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.stock_location_id).toBe(DEFAULT_WAREHOUSE);
    expect(row.quantity_on_hand).toBe(0);
    expect(row.quantity_allocated).toBe(0);
    expect(row.quantity_reserved).toBe(0);
    expect(typeof row.version).toBe('number');

    // The same figure is observable through the public read path. This GET is the
    // first read of this variant, so it is a clean cache miss that loads the row.
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
    // The row already exists from the first variant-create. Re-emit a synthetic
    // duplicate directly onto `inventory_queue`; the consumer must no-op.
    const duplicate: ICatalogVariantCreatedEvent = {
      productId: 0,
      variantId,
      sku,
      eventVersion: 'v1',
      occurredAt: new Date().toISOString(),
      correlationId: `e2e-auto-init-dup-${stamp}`,
    };
    await firstValueFrom(inventoryPublisher.emit(ROUTING_KEYS.CATALOG_VARIANT_CREATED, duplicate));

    // Give the consumer time to process the no-op, then assert the row count is
    // still exactly one and the figure is unchanged.
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
