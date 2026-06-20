import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { ReturnsRefundsE2ESpecDataSource } from './data-source/returns-refunds.e2e-spec.data-source';

// The returns policy-rejection paths (ADR-032) — both the Open-time guards and the
// explicit staff Reject. A return is not an unconditional right: the retail service
// enforces a return window + a returnable-quantity invariant when an RMA is opened, and
// even a validly-opened RMA can be rejected by order support before it is authorized.
// None of these paths moves stock or money. Asserted through PUBLIC state (the HTTP
// status + typed `code`, the RMA read, the public stock read, the uncached movements
// ledger) — never an event spy:
//   - Open-time RETURN_ORDER_NOT_RETURNABLE: an order that has not shipped (its
//     fulfillment axis is `unfulfilled`) has nothing to return — opening an RMA is 409.
//   - Open-time RETURN_QUANTITY_EXCEEDS_RETURNABLE: a delivered one-unit order can return
//     at most one unit — asking for two is 409.
//   - Explicit Reject: a validly-opened `requested` RMA, rejected by staff, walks to
//     `rejected` (terminal) with `closedAt` stamped and the reason folded into the notes;
//     it never reaches inspection, so no `restock` ever fires and NO stock moves.
//
// Self-provisioned, disjoint fixture (`e2e-return-rejected-*`): its own variant + stock,
// so the shared seeded variants are never touched.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';

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

interface IOrderLineBody {
  id: number;
  quantity: number;
}

interface IOrderBody {
  id: number;
  status: string;
  fulfillmentStatus: string;
  lines: IOrderLineBody[];
}

interface IFulfillmentBody {
  id: number;
  status: string;
}

interface IReturnLineBody {
  id: number;
  orderLineId: number;
  quantity: number;
}

interface IReturnBody {
  id: number;
  status: string;
  notes: string | null;
  closedAt: string | null;
  lines: IReturnLineBody[];
}

interface IErrorBody {
  statusCode: number;
  code: string;
}

interface IMovementBody {
  id: number;
  type: string;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Returns rejection: open-time guards + explicit staff reject (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: ReturnsRefundsE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let customerToken: string;

  let variantId: number;
  let unshippedOrder: IOrderBody;
  let deliveredOrder: IOrderBody;
  let deliveredLineId: number;
  let rejectRmaId: number;
  let onHandAfterDelivery: number;

  const RECEIVED_QTY = 10;
  const UNIT_PRICE_MINOR = 1999;

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
        name: `E2E Return Rejected ${label} ${stamp}`,
        slug: `e2e-return-rejected-${label}-${stamp}`,
        description: 'return-rejected fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-RETREJ-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variant = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variant}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: UNIT_PRICE_MINOR });
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

  const warehouseLevel = async (variant: number): Promise<IStockLevelBody> => {
    const { body } = await server().get(`/api/inventory/variants/${variant}/stock`);
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

  const listReturnMovements = async (variant: number): Promise<IMovementBody[]> => {
    const { body } = await server()
      .get(`/api/inventory/variants/${variant}/movements`)
      .query({ type: 'return' })
      .set('Authorization', adminAuth);
    return (body as IPageBody<IMovementBody>).items;
  };

  // Places a one-unit order and returns the OrderView; does not ship it.
  const placeOneUnitOrder = async (idemSuffix: string): Promise<IOrderBody> => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    const cartId = (create.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: 1 });
    expect(add.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `return-rejected-${stamp}-${idemSuffix}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    return place.body as IOrderBody;
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

    dataSource = new ReturnsRefundsE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);
    customerToken = await customerLogin(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

    variantId = await provisionVariant('a', RECEIVED_QTY);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('rejects opening a return on an un-shipped order → 409 RETURN_ORDER_NOT_RETURNABLE', async () => {
    unshippedOrder = await placeOneUnitOrder('unshipped');
    expect(unshippedOrder.fulfillmentStatus).toBe('unfulfilled');

    const open = await server()
      .post(`/api/orders/${unshippedOrder.id}/returns`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        reasonCategory: 'changed-mind',
        lines: [{ orderLineId: unshippedOrder.lines[0].id, quantity: 1 }],
      });
    expect(open.status).toBe(HttpStatus.CONFLICT);
    expect((open.body as IErrorBody).code).toBe('RETURN_ORDER_NOT_RETURNABLE');

    // The failed open created no RMA and moved no stock.
    const list = await server()
      .get(`/api/orders/${unshippedOrder.id}/returns`)
      .set('Authorization', adminAuth);
    expect(list.status).toBe(HttpStatus.OK);
    expect(list.body as IReturnBody[]).toHaveLength(0);
    expect(await listReturnMovements(variantId)).toHaveLength(0);
  });

  it('places, ships, and delivers a one-unit order (so it is returnable)', async () => {
    deliveredOrder = await placeOneUnitOrder('delivered');
    deliveredLineId = deliveredOrder.lines[0].id;

    const createFul = await server()
      .post(`/api/orders/${deliveredOrder.id}/fulfillments`)
      .set('Authorization', adminAuth)
      .send({
        stockLocationId: DEFAULT_WAREHOUSE,
        lines: [{ orderLineId: deliveredLineId, quantity: 1 }],
      });
    expect(createFul.status).toBe(HttpStatus.CREATED);
    const fulfillmentId = (createFul.body as IFulfillmentBody).id;

    const ship = await server()
      .post(`/api/orders/${deliveredOrder.id}/fulfillments/${fulfillmentId}/ship`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `return-rejected-${stamp}-ship`)
      .send({ trackingNumber: '1Z999AA10123456790', carrier: 'UPS' });
    expect(ship.status).toBe(HttpStatus.OK);

    const deliver = await server()
      .post(`/api/orders/${deliveredOrder.id}/fulfillments/${fulfillmentId}/deliver`)
      .set('Authorization', adminAuth);
    expect(deliver.status).toBe(HttpStatus.OK);

    onHandAfterDelivery = (await warehouseLevel(variantId)).quantityOnHand;
  });

  it('rejects opening a return for more units than were ordered → 409 RETURN_QUANTITY_EXCEEDS_RETURNABLE', async () => {
    const open = await server()
      .post(`/api/orders/${deliveredOrder.id}/returns`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        reasonCategory: 'wrong-item',
        lines: [{ orderLineId: deliveredLineId, quantity: 2 }],
      });
    expect(open.status).toBe(HttpStatus.CONFLICT);
    expect((open.body as IErrorBody).code).toBe('RETURN_QUANTITY_EXCEEDS_RETURNABLE');

    // No RMA was opened for the delivered order yet.
    const list = await server()
      .get(`/api/orders/${deliveredOrder.id}/returns`)
      .set('Authorization', adminAuth);
    expect(list.body as IReturnBody[]).toHaveLength(0);
  });

  it('opens a valid RMA then staff rejects it → rejected + closedAt set + no stock change', async () => {
    const open = await server()
      .post(`/api/orders/${deliveredOrder.id}/returns`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        reasonCategory: 'changed-mind',
        lines: [{ orderLineId: deliveredLineId, quantity: 1 }],
      });
    expect(open.status).toBe(HttpStatus.CREATED);
    const rma = open.body as IReturnBody;
    expect(rma.status).toBe('requested');
    rejectRmaId = rma.id;

    const reject = await server()
      .post(`/api/returns/${rejectRmaId}/reject`)
      .set('Authorization', adminAuth)
      .send({ reason: 'Goods show signs of use beyond the policy' });
    expect(reject.status).toBe(HttpStatus.OK);

    const rejected = reject.body as IReturnBody;
    expect(rejected.status).toBe('rejected');
    // Rejection is terminal — it stamps `closedAt` (the RMA reuses the close timestamp).
    expect(rejected.closedAt).not.toBeNull();
    // The reject reason is folded into the RMA notes (no dedicated column).
    expect(rejected.notes).toContain('Goods show signs of use beyond the policy');

    // A rejected RMA never reaches inspection, so no `restock` ever fires: on-hand is
    // exactly the post-delivery baseline and the `return` ledger stays empty.
    expect((await warehouseLevel(variantId)).quantityOnHand).toBe(onHandAfterDelivery);
    expect(await listReturnMovements(variantId)).toHaveLength(0);

    // Re-rejecting the terminal RMA is a 409 invalid transition (idempotency guard).
    const reReject = await server()
      .post(`/api/returns/${rejectRmaId}/reject`)
      .set('Authorization', adminAuth)
      .send({ reason: 'again' });
    expect(reReject.status).toBe(HttpStatus.CONFLICT);
    expect((reReject.body as IErrorBody).code).toBe('RETURN_INVALID_STATUS_TRANSITION');
  });
});
