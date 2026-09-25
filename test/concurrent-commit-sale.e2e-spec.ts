import { randomUUID } from 'crypto';

import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import {
  AllocateStockUseCase,
  CommitSaleUseCase,
  ReserveStockUseCase,
  RestockFromReturnUseCase,
  TransferStockUseCase,
} from '../apps/inventory-microservice/src/modules/stock/application/use-cases';
import { CommitSaleDedupeE2ESpecDataSource } from './data-source/commit-sale-dedupe.e2e-spec.data-source';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';
const BACKUP_STORE = 'backup-store';

const FULFILLMENT_REFERENCE_TYPE = 'fulfillment';
const RETURN_REQUEST_REFERENCE_TYPE = 'return-request';
const TRANSFER_REFERENCE_TYPE = 'transfer';

describe('Concurrent ledger writes — one redelivered request must move stock once (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: CommitSaleDedupeE2ESpecDataSource;

  let reserveStock: ReserveStockUseCase;
  let allocateStock: AllocateStockUseCase;
  let commitSale: CommitSaleUseCase;
  let restockFromReturn: RestockFromReturnUseCase;
  let transferStock: TransferStockUseCase;

  const stamp = Date.now();
  let adminAuth: string;
  let nextReference = 0;
  const reference = (): string => `e2e-dedupe-${stamp}-${++nextReference}`;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as { accessToken: string }).accessToken}`;
  };

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const waitForStockRow = async (variantId: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRow(variantId, DEFAULT_WAREHOUSE)) === undefined) {
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
        name: `E2E Dedupe ${label} ${stamp}`,
        slug: `e2e-dedupe-${label}-${stamp}`,
        description: 'ledger-dedupe fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-DEDUPE-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

  const allocate = async (
    lines: { variantId: number; quantity: number }[],
  ): Promise<{ cartId: string; orderId: number }> => {
    const cartId = randomUUID();
    await dataSource.createGuestCart(cartId);
    const orderId = Math.floor(Math.random() * 1_000_000_000);
    for (const line of lines) {
      await reserveStock.execute({
        cartId,
        variantId: line.variantId,
        quantity: line.quantity,
        correlationId: cartId,
      });
    }
    await allocateStock.execute({ cartId, orderId, lines, correlationId: cartId });
    return { cartId, orderId };
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

    reserveStock = inventoryMicroservice.get(ReserveStockUseCase, { strict: false });
    allocateStock = inventoryMicroservice.get(AllocateStockUseCase, { strict: false });
    commitSale = inventoryMicroservice.get(CommitSaleUseCase, { strict: false });
    restockFromReturn = inventoryMicroservice.get(RestockFromReturnUseCase, { strict: false });
    transferStock = inventoryMicroservice.get(TransferStockUseCase, { strict: false });

    dataSource = new CommitSaleDedupeE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  describe('commit-sale: two deliveries of one fulfillment, in flight at once', () => {
    it(
      'decrements stock exactly once and writes exactly one `sale` row',
      async () => {
        const variantId = await provisionVariant('commit', 10);
        const { orderId } = await allocate([{ variantId, quantity: 3 }]);

        const before = await dataSource.getStockLevelRow(variantId, DEFAULT_WAREHOUSE);
        expect(before).toMatchObject({ quantity_on_hand: 10, quantity_allocated: 3 });

        const fulfillmentId = reference();
        const payload = {
          orderId,
          fulfillmentId,
          lines: [{ variantId, stockLocationId: DEFAULT_WAREHOUSE, quantity: 3 }],
          correlationId: fulfillmentId,
        };

        const outcomes = await Promise.all([
          commitSale.execute({ ...payload }),
          commitSale.execute({ ...payload }),
        ]);
        for (const outcome of outcomes) {
          expect(outcome.committed).toHaveLength(1);
        }

        const after = await dataSource.getStockLevelRow(variantId, DEFAULT_WAREHOUSE);
        expect(after).toMatchObject({ quantity_on_hand: 7, quantity_allocated: 0 });

        const movements = await dataSource.getMovementRows(
          FULFILLMENT_REFERENCE_TYPE,
          fulfillmentId,
          'sale',
        );
        expect(movements).toHaveLength(1);
        expect(movements[0].quantity).toBe(-3);
      },
      timeout,
    );
  });

  describe('restock-from-return: two deliveries of one return request, in flight at once', () => {
    it(
      'credits stock exactly once and writes exactly one `return` row',
      async () => {
        const variantId = await provisionVariant('restock', 4);

        const before = await dataSource.getStockLevelRow(variantId, DEFAULT_WAREHOUSE);
        expect(before).toMatchObject({ quantity_on_hand: 4 });

        const returnRequestId = Math.floor(Math.random() * 1_000_000_000);
        const payload = {
          returnRequestId,
          lines: [{ returnLineId: 1, variantId, stockLocationId: DEFAULT_WAREHOUSE, quantity: 2 }],
          correlationId: reference(),
        };

        const outcomes = await Promise.all([
          restockFromReturn.execute({ ...payload }),
          restockFromReturn.execute({ ...payload }),
        ]);
        for (const outcome of outcomes) {
          expect(outcome.restocked).toHaveLength(1);
        }

        const after = await dataSource.getStockLevelRow(variantId, DEFAULT_WAREHOUSE);
        expect(after).toMatchObject({ quantity_on_hand: 6 });

        const movements = await dataSource.getMovementRows(
          RETURN_REQUEST_REFERENCE_TYPE,
          String(returnRequestId),
          'return',
        );
        expect(movements).toHaveLength(1);
        expect(movements[0].quantity).toBe(2);
      },
      timeout,
    );
  });

  describe('the constraint must stay SCOPED — the writes that legitimately share a reference', () => {
    it(
      'a two-line shipment writes one `sale` row per line under ONE fulfillmentId',
      async () => {
        const first = await provisionVariant('multi-a', 5);
        const second = await provisionVariant('multi-b', 5);
        const { orderId } = await allocate([
          { variantId: first, quantity: 2 },
          { variantId: second, quantity: 1 },
        ]);

        const fulfillmentId = reference();
        const outcome = await commitSale.execute({
          orderId,
          fulfillmentId,
          lines: [
            { variantId: first, stockLocationId: DEFAULT_WAREHOUSE, quantity: 2 },
            { variantId: second, stockLocationId: DEFAULT_WAREHOUSE, quantity: 1 },
          ],
          correlationId: fulfillmentId,
        });
        expect(outcome.committed).toHaveLength(2);

        const movements = await dataSource.getMovementRows(
          FULFILLMENT_REFERENCE_TYPE,
          fulfillmentId,
          'sale',
        );
        expect(movements).toHaveLength(2);
        expect(movements.map((row) => Number(row.variant_id)).sort()).toEqual(
          [first, second].sort(),
        );
      },
      timeout,
    );

    it(
      'a transfer still writes TWO `adjustment` rows under ONE transfer reference',
      async () => {
        const variantId = await provisionVariant('transfer', 6);

        await transferStock.execute({
          variantId,
          fromLocationId: DEFAULT_WAREHOUSE,
          toLocationId: BACKUP_STORE,
          quantity: 2,
          correlationId: reference(),
        });

        const source = await dataSource.getStockLevelRow(variantId, DEFAULT_WAREHOUSE);
        const destination = await dataSource.getStockLevelRow(variantId, BACKUP_STORE);
        expect(source).toMatchObject({ quantity_on_hand: 4 });
        expect(destination).toMatchObject({ quantity_on_hand: 2 });

        const rows = await dataSource.query(
          `SELECT reference_id, quantity FROM stock_movement
           WHERE variant_id = ? AND reference_type = ? AND type = 'adjustment' ORDER BY id;`,
          [variantId, TRANSFER_REFERENCE_TYPE],
        );
        expect(rows).toHaveLength(2);
        expect(rows[0].reference_id).toBe(rows[1].reference_id);
        expect([rows[0].quantity, rows[1].quantity].sort((a: number, b: number) => a - b)).toEqual([
          -2, 2,
        ]);
      },
      timeout,
    );
  });
});
