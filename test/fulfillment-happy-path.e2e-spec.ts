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

// The fulfillment happy path end-to-end (ADR-031). A customer places a one-line
// order (qty 2, authorize-on-place), then an operator drives the shipment all the
// way: create one fulfillment covering the line in full → ship it → deliver it. The
// proof spans all four status axes and crosses the service boundary into inventory:
//   - the order's three axes (lifecycle / payment / fulfillment) and the
//     fulfillment's own (fourth) axis advance exactly as the lifecycle prescribes;
//   - Ship CAPTURES the authorized payment automatically (paymentStatus → captured)
//     and, only AFTER its local commit, Commit-Sale physically decrements stock — so
//     BOTH `quantity_on_hand` AND `quantity_allocated` drop (an allocation is reclassed
//     to a shipment, not a within-warehouse move);
//   - the audit ledger gains exactly one negative `sale` row per shipped line,
//     referencing the fulfillment (the `fulfillmentId` idempotency anchor).
//
// Asserted through PUBLIC state only (the order GET, the public stock read, the
// uncached movements ledger) — never an event spy or a broker side effect (the
// project convention). Commit-Sale is awaited inside the ship use case before the
// HTTP response returns, and the movements read is uncached, so the `sale` row is
// observable immediately with no sleep.
//
// Self-provisioned, disjoint fixture (`e2e-ful-happy-*`): its own product, variant,
// price, and `receive`d stock, so the shared seeded variants are never touched.
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
  variantId: number;
  quantity: number;
  status: string;
}

interface IPaymentBody {
  status: string;
  capturedAt: string | null;
  authorizedAt: string | null;
}

interface IOrderBody {
  id: number;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  lines: IOrderLineBody[];
  payment?: IPaymentBody;
}

interface IFulfillmentBody {
  id: number;
  orderId: number;
  stockLocationId: string;
  status: string;
  trackingNumber: string | null;
  carrier: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  lines: { id: number; orderLineId: number; quantity: number }[];
}

interface IMovementBody {
  id: number;
  type: string;
  quantity: number;
  referenceType: string | null;
  referenceId: string | null;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Fulfillment happy path: place → fulfill → ship → deliver (e2e)', () => {
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
  let cartId: string;
  let order: IOrderBody;
  let orderLineId: number;
  let fulfillmentId: number;

  const ORDERED_QTY = 2;
  const RECEIVED_QTY = 5;

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
        name: `E2E Fulfillment Happy ${label} ${stamp}`,
        slug: `e2e-ful-happy-${label}-${stamp}`,
        description: 'fulfillment happy-path fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-FULHAPPY-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variant = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variant}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });
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

  const listSales = async (variant: number): Promise<IMovementBody[]> => {
    const { body } = await server()
      .get(`/api/inventory/variants/${variant}/movements`)
      .query({ type: 'sale' })
      .set('Authorization', adminAuth);
    return (body as IPageBody<IMovementBody>).items;
  };

  const getOrder = async (orderId: number): Promise<IOrderBody> => {
    const { body } = await server().get(`/api/orders/${orderId}`).set('Authorization', adminAuth);
    return body as IOrderBody;
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

    variantId = await provisionVariant('a', RECEIVED_QTY);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('places a one-line order (qty 2): pending / authorized / unfulfilled, stock reserved→allocated', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    cartId = (create.body as ICartBody).id;

    const addLine = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: ORDERED_QTY });
    expect(addLine.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `ful-happy-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);

    order = place.body as IOrderBody;
    expect(order.status).toBe('pending');
    expect(order.paymentStatus).toBe('authorized');
    expect(order.fulfillmentStatus).toBe('unfulfilled');
    expect(order.lines).toHaveLength(1);
    orderLineId = order.lines[0].id;
    expect(order.lines[0].status).toBe('allocated');
    expect(order.payment?.status).toBe('authorized');
    expect(order.payment?.capturedAt).toBeNull();

    // Place moved the cart hold (reserved) to an order allocation: on-hand intact,
    // allocated up, reserved back to 0.
    const level = await warehouseLevel(variantId);
    expect(level.quantityOnHand).toBe(RECEIVED_QTY);
    expect(level.quantityAllocated).toBe(ORDERED_QTY);
    expect(level.quantityReserved).toBe(0);
    expect(level.available).toBe(RECEIVED_QTY - ORDERED_QTY);
  });

  it('creates one fulfillment covering the line in full → pending; order axes unchanged', async () => {
    const createFul = await server()
      .post(`/api/orders/${order.id}/fulfillments`)
      .set('Authorization', adminAuth)
      .send({
        stockLocationId: DEFAULT_WAREHOUSE,
        lines: [{ orderLineId, quantity: ORDERED_QTY }],
      });
    expect(createFul.status).toBe(HttpStatus.CREATED);

    const fulfillment = createFul.body as IFulfillmentBody;
    expect(fulfillment.status).toBe('pending');
    expect(fulfillment.orderId).toBe(order.id);
    expect(fulfillment.stockLocationId).toBe(DEFAULT_WAREHOUSE);
    expect(fulfillment.trackingNumber).toBeNull();
    expect(fulfillment.shippedAt).toBeNull();
    expect(fulfillment.lines).toHaveLength(1);
    expect(fulfillment.lines[0].orderLineId).toBe(orderLineId);
    expect(fulfillment.lines[0].quantity).toBe(ORDERED_QTY);
    fulfillmentId = fulfillment.id;

    // Creating a fulfillment is a plan, not a physical move: the order axes and the
    // stock counters are untouched (the flip is Ship's job).
    const fresh = await getOrder(order.id);
    expect(fresh.status).toBe('pending');
    expect(fresh.paymentStatus).toBe('authorized');
    expect(fresh.fulfillmentStatus).toBe('unfulfilled');
    expect(fresh.lines[0].status).toBe('allocated');

    const level = await warehouseLevel(variantId);
    expect(level.quantityOnHand).toBe(RECEIVED_QTY);
    expect(level.quantityAllocated).toBe(ORDERED_QTY);
  });

  it('ships the fulfillment → shipped; payment auto-captured; on-hand AND allocated decrement', async () => {
    const ship = await server()
      .post(`/api/orders/${order.id}/fulfillments/${fulfillmentId}/ship`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `ful-happy-${stamp}-ship`)
      .send({ trackingNumber: '1Z999AA10123456784', carrier: 'UPS' });
    expect(ship.status).toBe(HttpStatus.OK);

    const shipped = ship.body as IFulfillmentBody;
    expect(shipped.status).toBe('shipped');
    expect(shipped.trackingNumber).toBe('1Z999AA10123456784');
    expect(shipped.carrier).toBe('UPS');
    expect(shipped.shippedAt).not.toBeNull();

    // The order's lifecycle axis stays `pending` (Ship advances only fulfillment); the
    // payment axis flips to `captured` (ship-triggered capture) and the fulfillment axis
    // rolls up to `shipped` because the single line is fully shipped.
    const fresh = await getOrder(order.id);
    expect(fresh.status).toBe('pending');
    expect(fresh.paymentStatus).toBe('captured');
    expect(fresh.fulfillmentStatus).toBe('shipped');
    expect(fresh.lines[0].status).toBe('shipped');
    expect(fresh.payment?.status).toBe('captured');
    expect(fresh.payment?.capturedAt).not.toBeNull();

    // Commit-Sale physically decremented BOTH counters: on-hand 5→3 and allocated
    // 2→0. `available` is unchanged (both counters already subtracted from it).
    const level = await warehouseLevel(variantId);
    expect(level.quantityOnHand).toBe(RECEIVED_QTY - ORDERED_QTY);
    expect(level.quantityAllocated).toBe(0);
    expect(level.quantityReserved).toBe(0);
    expect(level.available).toBe(RECEIVED_QTY - ORDERED_QTY);
  });

  it('writes exactly one negative `sale` movement for the shipped line, referencing the fulfillment', async () => {
    const sales = await listSales(variantId);
    expect(sales).toHaveLength(1);
    expect(sales[0].type).toBe('sale');
    expect(sales[0].quantity).toBe(-ORDERED_QTY);
    expect(sales[0].referenceType).toBe('fulfillment');
    expect(sales[0].referenceId).toBe(String(fulfillmentId));
  });

  it('delivers the fulfillment → delivered; the order rolls up to delivered on both axes', async () => {
    const deliver = await server()
      .post(`/api/orders/${order.id}/fulfillments/${fulfillmentId}/deliver`)
      .set('Authorization', adminAuth);
    expect(deliver.status).toBe(HttpStatus.OK);

    const delivered = deliver.body as IFulfillmentBody;
    expect(delivered.status).toBe('delivered');
    expect(delivered.deliveredAt).not.toBeNull();

    // The order's only fulfillment is delivered, so the lifecycle AND fulfillment axes
    // both roll up to `delivered`; payment stays `captured`.
    const fresh = await getOrder(order.id);
    expect(fresh.status).toBe('delivered');
    expect(fresh.paymentStatus).toBe('captured');
    expect(fresh.fulfillmentStatus).toBe('delivered');

    // Delivery moves no stock: the post-ship counters and the single `sale` row stand.
    const level = await warehouseLevel(variantId);
    expect(level.quantityOnHand).toBe(RECEIVED_QTY - ORDERED_QTY);
    expect(level.quantityAllocated).toBe(0);
    expect(await listSales(variantId)).toHaveLength(1);
  });
});
