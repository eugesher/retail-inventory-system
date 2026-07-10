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

// Cancel Order before any shipment — the pre-fulfillment unhappy terminal (ADR-031).
// A customer places a one-line order (authorize-only — nothing has shipped), then the
// OWNER cancels it (owner-or-staff `order:cancel`, no permission gate). The cancel:
//   - flips the order's lifecycle axis to `cancelled`;
//   - VOIDS the authorized payment (no money was ever taken — `authorized → voided`);
//   - releases the order's stock allocation back to `available` — so
//     `quantity_allocated` drops to 0, `available` returns to the received quantity,
//     and the audit ledger gains a negative `release` row referencing the order
//     (`reason_code = order-cancelled`).
//
// Asserted through PUBLIC state (the order GET + the public stock read + the uncached
// movements ledger) — never an event spy. The allocation release is awaited inside the
// cancel use case before the HTTP response returns (best-effort with retry, but
// synchronous to the caller), and the movements read is uncached, so the `release` row
// is observable immediately with no sleep.
//
// Self-provisioned, disjoint fixture (`e2e-cancel-pre-*`): its own variant, so the
// shared seeded variants are never touched.
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

interface IPaymentBody {
  status: string;
}

interface IOrderBody {
  id: number;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  lines: {
    id: number;
    variantId: number;
    quantity: number;
    cancelledQuantity: number;
    status: string;
  }[];
  payment?: IPaymentBody;
}

interface IMovementBody {
  id: number;
  type: string;
  quantity: number;
  reasonCode: string | null;
  referenceType: string | null;
  referenceId: string | null;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Cancel Order pre-fulfillment: void payment + release allocation (e2e)', () => {
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
        name: `E2E Cancel Pre ${label} ${stamp}`,
        slug: `e2e-cancel-pre-${label}-${stamp}`,
        description: 'cancel-pre-fulfillment fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-CANPRE-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

  const listReleases = async (variant: number): Promise<IMovementBody[]> => {
    const { body } = await server()
      .get(`/api/inventory/variants/${variant}/movements`)
      .query({ type: 'release' })
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

  it('places a one-line order (qty 2): pending / authorized, stock allocated', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    cartId = (create.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: ORDERED_QTY });
    expect(add.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `cancel-pre-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);

    order = place.body as IOrderBody;
    expect(order.status).toBe('pending');
    expect(order.paymentStatus).toBe('authorized');

    const level = await warehouseLevel(variantId);
    expect(level.quantityAllocated).toBe(ORDERED_QTY);
    expect(level.available).toBe(RECEIVED_QTY - ORDERED_QTY);
    // No release row exists yet — nothing has been cancelled.
    expect(await listReleases(variantId)).toHaveLength(0);
  });

  it('the owning customer cancels the pending order → cancelled + payment voided', async () => {
    const cancel = await server()
      .post(`/api/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ reason: 'Customer changed their mind' });
    expect(cancel.status).toBe(HttpStatus.OK);

    const cancelled = cancel.body as IOrderBody;
    expect(cancelled.status).toBe('cancelled');
    // The authorized payment is voided (no money was ever taken). The order's payment
    // AXIS keeps its value (there is no `voided` member on it); the payment ROW carries
    // `voided` — the deliberate orthogonality of the two payment enums.
    expect(cancelled.payment?.status).toBe('voided');

    // Re-read confirms the persisted cancelled state.
    const fresh = await getOrder(order.id);
    expect(fresh.status).toBe('cancelled');
    expect(fresh.payment?.status).toBe('voided');
  });

  it('the allocation is released: allocated drops to 0, available returns, a `release` row appears', async () => {
    const level = await warehouseLevel(variantId);
    expect(level.quantityAllocated).toBe(0);
    expect(level.quantityReserved).toBe(0);
    expect(level.available).toBe(RECEIVED_QTY);
    expect(level.quantityOnHand).toBe(RECEIVED_QTY);

    // The cancel released the order's allocation back to available, leaving exactly one
    // negative `release` ledger row referencing the order, with the `order-cancelled`
    // reason. The ledger is an audit trail (a release is a fixed-negative type), not the
    // balance authority.
    const releases = await listReleases(variantId);
    expect(releases).toHaveLength(1);
    expect(releases[0].type).toBe('release');
    expect(releases[0].quantity).toBe(-ORDERED_QTY);
    expect(releases[0].referenceType).toBe('order');
    expect(releases[0].referenceId).toBe(String(order.id));
    expect(releases[0].reasonCode).toBe('order-cancelled');
  });

  it('re-cancelling the already-cancelled order is rejected 409 (ORDER_NOT_CANCELLABLE)', async () => {
    const recancel = await server()
      .post(`/api/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ reason: 'again' });
    expect(recancel.status).toBe(HttpStatus.CONFLICT);
    expect((recancel.body as { code: string }).code).toBe('ORDER_NOT_CANCELLABLE');

    // No second release row — the idempotency guard stops a double release.
    expect(await listReleases(variantId)).toHaveLength(1);
  });

  // `POST /api/orders/:orderId/lines/:lineId/cancel` (staff `order:cancel`) — the narrower
  // sibling of the whole-order cancel: it cancels the **unshipped quantity of one line**,
  // releases exactly that slice's allocation, and mutates no money. The cancellable
  // remainder is `ordered − alreadyFulfilled`; an omitted `quantity` cancels all of it.
  //
  // Runs on its own variant + order so the whole-order assertions above (which count this
  // suite's `release` rows for `variantId`) keep measuring exactly one row.
  describe('POST /api/orders/:orderId/lines/:lineId/cancel — staff partial line cancel', () => {
    let lineVariantId: number;
    let lineOrder: IOrderBody;

    beforeAll(async () => {
      lineVariantId = await provisionVariant('b', RECEIVED_QTY);

      const create = await server()
        .post('/api/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ currency: 'USD' });
      const lineCartId = (create.body as ICartBody).id;

      const add = await server()
        .post(`/api/cart/${lineCartId}/lines`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ variantId: lineVariantId, quantity: ORDERED_QTY });
      expect(add.status).toBe(HttpStatus.OK);

      const place = await server()
        .post(`/api/cart/${lineCartId}/place`)
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', `cancel-line-${stamp}-place`)
        .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
      expect(place.status).toBe(HttpStatus.CREATED);
      lineOrder = place.body as IOrderBody;
    }, timeout);

    const cancelLine = (quantity?: number): Promise<supertest.Response> =>
      server()
        .post(`/api/orders/${lineOrder.id}/lines/${lineOrder.lines[0].id}/cancel`)
        .set('Authorization', adminAuth)
        .send(quantity === undefined ? {} : { quantity });

    it('cancels one of the two unshipped units: the slice’s allocation is released', async () => {
      const before = await warehouseLevel(lineVariantId);
      expect(before.quantityAllocated).toBe(ORDERED_QTY);

      const res = await cancelLine(1);
      expect(res.status).toBe(HttpStatus.OK);

      // The cancelled count is recorded on the line (ADR-040) — the money snapshot stands.
      const line = (res.body as IOrderBody).lines[0];
      expect(line.cancelledQuantity).toBe(1);
      expect(line.quantity).toBe(ORDERED_QTY);

      const after = await warehouseLevel(lineVariantId);
      expect(after.quantityAllocated).toBe(ORDERED_QTY - 1);
      expect(after.available).toBe(before.available + 1);
      // No money moves on a line cancel — on-hand is untouched too.
      expect(after.quantityOnHand).toBe(before.quantityOnHand);

      // `line-cancelled` is what distinguishes the ledger row from a whole-order cancel.
      const releases = await listReleases(lineVariantId);
      expect(releases).toHaveLength(1);
      expect(releases[0].type).toBe('release');
      expect(releases[0].quantity).toBe(-1);
      expect(releases[0].reasonCode).toBe('line-cancelled');
      expect(releases[0].referenceType).toBe('order');
      expect(releases[0].referenceId).toBe(String(lineOrder.id));
    });

    it('rejects cancelling more than the unshipped remainder → 409 FULFILLMENT_QUANTITY_EXCEEDS_REMAINING', async () => {
      const res = await cancelLine(ORDERED_QTY + 5);

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect((res.body as { code: string }).code).toBe('FULFILLMENT_QUANTITY_EXCEEDS_REMAINING');
    });

    it('rejects an order line that does not belong to the order → 404 ORDER_LINE_NOT_FOUND', async () => {
      const res = await server()
        .post(`/api/orders/${lineOrder.id}/lines/99999999/cancel`)
        .set('Authorization', adminAuth)
        .send({ quantity: 1 });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect((res.body as { code: string }).code).toBe('ORDER_LINE_NOT_FOUND');
    });

    // The regression ADR-040 closes, asserted through the PUBLIC stock read: before the
    // cancelled count was persisted, each repeat call released the same units again and
    // drove `quantity_allocated` below zero.
    it('cancels the second unit, then refuses a third — releasing the allocation exactly twice', async () => {
      // One unit is already cancelled by the first test; cancel the remaining one.
      const second = await cancelLine(1);
      expect(second.status).toBe(HttpStatus.OK);

      const line = (second.body as IOrderBody).lines[0];
      expect(line.cancelledQuantity).toBe(ORDERED_QTY);
      // Cancelling the last active unit is terminal for the line.
      expect(line.status).toBe('cancelled');

      const drained = await warehouseLevel(lineVariantId);
      expect(drained.quantityAllocated).toBe(0);

      // Nothing active remains, so a third cancel has nothing to cancel.
      const third = await cancelLine(1);
      expect(third.status).toBe(HttpStatus.CONFLICT);
      expect((third.body as { code: string }).code).toBe('FULFILLMENT_QUANTITY_EXCEEDS_REMAINING');

      // An omitted quantity ("cancel whatever remains") is refused for the same reason —
      // it must not silently resolve to the already-cancelled units.
      const fourth = await cancelLine();
      expect(fourth.status).toBe(HttpStatus.CONFLICT);

      // The decisive assertions: exactly two release rows, and the allocation never went
      // negative. Before the fix both of these blew past their bound.
      const releases = await listReleases(lineVariantId);
      expect(releases).toHaveLength(2);
      expect(releases.every((r) => r.quantity === -1)).toBe(true);

      const settled = await warehouseLevel(lineVariantId);
      expect(settled.quantityAllocated).toBe(0);
      expect(settled.quantityOnHand).toBe(RECEIVED_QTY);
      expect(settled.available).toBe(RECEIVED_QTY);
    });

    it('refuses to ship a fully-cancelled line', async () => {
      const res = await server()
        .post(`/api/orders/${lineOrder.id}/fulfillments`)
        .set('Authorization', adminAuth)
        .send({ lines: [{ orderLineId: lineOrder.lines[0].id, quantity: 1 }] });

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect((res.body as { code: string }).code).toBe('FULFILLMENT_QUANTITY_EXCEEDS_REMAINING');
    });
  });
});
