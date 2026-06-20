import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import {
  IPaymentRowProjection,
  ReturnsRefundsE2ESpecDataSource,
} from './data-source/returns-refunds.e2e-spec.data-source';

// Auto-refund-from-cancel (ADR-032) — the one cancellation path that returns money. A
// customer places a one-unit order; an operator captures the payment explicitly WITHOUT
// shipping; then the order is cancelled. Cancelling a captured-but-unshipped order flags
// the payment for refund and emits `retail.order.cancelled` with
// `paymentFlaggedForRefund=true`; the retail `OrderCancelledConsumer` consumes that event
// off the retail queue and issues a FULL refund INLINE — no HTTP call, no gateway endpoint.
//
// Because the refund rides an ASYNCHRONOUS event consumer (unlike Issue Refund's synchronous
// gateway call), the proof must wait for eventual consistency: the suite polls the `payment`
// row with a bounded retry until the auto-refund lands, then asserts through PUBLIC state
// (the DB payment/refund rows + the order GET):
//   - the payment ends `refunded` with `refunded_amount_minor === amount_minor` (a full
//     refund of the captured total) and `flagged_for_refund` cleared back to 0;
//   - exactly ONE issued refund row exists, with `reason='order-cancelled'` — the
//     refundable-remainder guard makes a redelivery idempotent (a second delivery computes
//     remainder 0 and issues nothing), so the cumulative refund never exceeds the captured
//     amount.
//
// `flagged_for_refund` and `refunded_amount_minor` are not on the `PaymentView`, so they are
// read straight from the `payment` row. Self-provisioned, disjoint fixture
// (`e2e-auto-refund-*`): its own variant + stock, so the shared seeded variants are never
// touched.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

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

interface ICartBody {
  id: string;
}

interface IPaymentBody {
  id: number;
  status: string;
  amountMinor: number;
}

interface IOrderBody {
  id: number;
  status: string;
  paymentStatus: string;
  lines: { id: number; quantity: number }[];
  payment?: IPaymentBody;
}

describe('Auto-refund from cancel: capture (no ship) → cancel → consumer refunds (e2e)', () => {
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
  let order: IOrderBody;
  let paymentId: number;

  const RECEIVED_QTY = 5;
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

  // Polls the payment row until the asynchronous auto-refund consumer has flipped it to
  // `refunded` (the eventual-consistency convention). Returns the settled row.
  const waitForAutoRefund = async (
    orderId: number,
    deadlineMs = 25_000,
  ): Promise<IPaymentRowProjection> => {
    const start = Date.now();
    for (;;) {
      const payment = await dataSource.getPaymentByOrderId(orderId);
      if (payment?.status === 'refunded') {
        return payment;
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(
          `Timed out waiting for the auto-refund consumer to refund order ${orderId} (payment status: ${payment?.status})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const provisionVariant = async (label: string, onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Auto Refund ${label} ${stamp}`,
        slug: `e2e-auto-refund-${label}-${stamp}`,
        description: 'auto-refund-from-cancel fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-AUTOREF-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
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

  it('places a one-unit order and captures the payment explicitly (without shipping)', async () => {
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
      .set('Idempotency-Key', `auto-refund-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    order = place.body as IOrderBody;
    expect(order.paymentStatus).toBe('authorized');

    // Explicit capture (no ship) — the only state where a later cancel flags the payment
    // for refund (a never-captured cancel just voids the authorization).
    const capture = await server()
      .post(`/api/orders/${order.id}/payments/capture`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `auto-refund-${stamp}-capture`)
      .send({});
    expect(capture.status).toBe(HttpStatus.OK);

    const captured = capture.body as IOrderBody;
    expect(captured.paymentStatus).toBe('captured');
    expect(captured.payment?.status).toBe('captured');
    paymentId = captured.payment!.id;

    // The captured payment carries no refund yet, and is not flagged.
    const payment = await dataSource.getPaymentByOrderId(order.id);
    expect(payment?.status).toBe('captured');
    expect(payment?.amountMinor).toBe(UNIT_PRICE_MINOR);
    expect(payment?.refundedAmountMinor).toBe(0);
    expect(payment?.flaggedForRefund).toBe(0);
    expect(await dataSource.getRefundsByOrderId(order.id)).toHaveLength(0);
  });

  it('cancels the captured-but-unshipped order → the consumer auto-issues a full refund', async () => {
    const cancel = await server()
      .post(`/api/orders/${order.id}/cancel`)
      .set('Authorization', adminAuth)
      .send({ reason: 'Customer cancelled after capture' });
    expect(cancel.status).toBe(HttpStatus.OK);
    expect((cancel.body as IOrderBody).status).toBe('cancelled');

    // The auto-refund rides the asynchronous `retail.order.cancelled` consumer, so wait for
    // it to settle the payment to `refunded`.
    const payment = await waitForAutoRefund(order.id);

    // The full captured amount was refunded, and the cancel flag was cleared by the full
    // refund (a partial refund would have left it set as the manual-retry anchor).
    expect(payment.status).toBe('refunded');
    expect(payment.refundedAmountMinor).toBe(UNIT_PRICE_MINOR);
    expect(payment.refundedAmountMinor).toBe(payment.amountMinor);
    expect(payment.flaggedForRefund).toBe(0);

    // Exactly one issued refund row, system-attributed with the `order-cancelled` reason —
    // the refundable-remainder guard makes any event redelivery idempotent, so the
    // cumulative refund never exceeds the captured amount.
    const refunds = await dataSource.getRefundsByOrderId(order.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe('issued');
    expect(refunds[0].paymentId).toBe(paymentId);
    expect(refunds[0].amountMinor).toBe(UNIT_PRICE_MINOR);
    expect(refunds[0].reason).toBe('order-cancelled');
  });

  it('the order/refund reads reflect the auto-issued refund', async () => {
    // The order's embedded payment view shows the refunded payment row.
    const fresh = await getOrder(order.id);
    expect(fresh.status).toBe('cancelled');
    expect(fresh.payment?.status).toBe('refunded');

    // List Refunds surfaces the single auto-issued refund over HTTP.
    const list = await server()
      .get(`/api/orders/${order.id}/refunds`)
      .set('Authorization', adminAuth);
    expect(list.status).toBe(HttpStatus.OK);
    const refunds = list.body as { status: string; amountMinor: number; reason: string }[];
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe('issued');
    expect(refunds[0].amountMinor).toBe(UNIT_PRICE_MINOR);
  });
});
