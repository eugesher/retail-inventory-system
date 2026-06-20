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

// Manual (goodwill) refunds without a return (ADR-032), plus the double-issue idempotency
// case. A customer places a one-unit order; an operator captures the payment, then issues
// staff-initiated refunds directly against it (no RMA involved — the chargeback / goodwill /
// price-adjustment path). Asserted through PUBLIC state (the RefundView response, the order
// GET, the DB payment/refund rows):
//   - a PARTIAL refund leaves the payment `captured` and accumulates `refunded_amount_minor`;
//   - the FINAL refund that exhausts the captured total flips the payment to `refunded`;
//   - DOUBLE-ISSUE IDEMPOTENCY: re-issuing the SAME `(paymentId, amountMinor, reason)` with
//     the same `Idempotency-Key` returns the SAME refund (HTTP 201, the natural already-issued
//     short-circuit — no second gateway call, no second row), so only ONE effective refund
//     takes hold and the cumulative `refunded_amount_minor` never doubles. (Per ADR-032 the
//     header itself is accepted + logged but not deduped — the dedupe is the already-issued
//     `(payment, amount, reason)` match plus the refundable ceiling.)
//   - the refundable CEILING rejects an over-refund: a request beyond the remaining
//     refundable amount is `409 REFUND_EXCEEDS_REFUNDABLE`, so the cumulative refund can never
//     exceed the captured `amount_minor`.
//
// Self-provisioned, disjoint fixture (`e2e-manual-refund-*`): its own variant + stock, so
// the shared seeded variants are never touched.
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
}

interface IOrderBody {
  id: number;
  status: string;
  paymentStatus: string;
  lines: { id: number; quantity: number }[];
  payment?: IPaymentBody;
}

interface IRefundBody {
  id: number;
  orderId: number;
  paymentId: number;
  amountMinor: number;
  status: string;
  reason: string;
  gatewayReference: string | null;
}

interface IErrorBody {
  statusCode: number;
  code: string;
}

describe('Manual refunds: partial, full, over-refund ceiling + double-issue idempotency (e2e)', () => {
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
  let firstRefundId: number;

  const RECEIVED_QTY = 5;
  // A round captured total makes the partial/remainder arithmetic obvious: 1000 partial,
  // 4000 remainder, 5000 captured.
  const GRAND_TOTAL_MINOR = 5000;
  const PARTIAL_MINOR = 1000;
  const REMAINDER_MINOR = GRAND_TOTAL_MINOR - PARTIAL_MINOR;
  const PARTIAL_REASON = 'Goodwill price adjustment';
  const IDEMPOTENCY_KEY = `manual-refund-${stamp}-partial`;

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
        name: `E2E Manual Refund ${label} ${stamp}`,
        slug: `e2e-manual-refund-${label}-${stamp}`,
        description: 'manual-refund fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-MANREF-${label}-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variant = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variant}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: GRAND_TOTAL_MINOR });
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

  const issueRefund = (
    body: { paymentId: number; amountMinor: number; reason: string },
    idempotencyKey: string,
  ): supertest.Test =>
    server()
      .post(`/api/orders/${order.id}/refunds`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);

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

  it('places a one-unit order and captures the payment (so it is refundable)', async () => {
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
      .set('Idempotency-Key', `manual-refund-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    order = place.body as IOrderBody;

    const capture = await server()
      .post(`/api/orders/${order.id}/payments/capture`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `manual-refund-${stamp}-capture`)
      .send({});
    expect(capture.status).toBe(HttpStatus.OK);
    const captured = capture.body as IOrderBody;
    expect(captured.payment?.status).toBe('captured');
    paymentId = captured.payment!.id;

    const payment = await dataSource.getPaymentByOrderId(order.id);
    expect(payment?.amountMinor).toBe(GRAND_TOTAL_MINOR);
    expect(payment?.refundedAmountMinor).toBe(0);
  });

  it('issues a partial refund → issued, payment stays captured, refunded_amount_minor accumulates', async () => {
    const refund = await issueRefund(
      { paymentId, amountMinor: PARTIAL_MINOR, reason: PARTIAL_REASON },
      IDEMPOTENCY_KEY,
    );
    expect(refund.status).toBe(HttpStatus.CREATED);

    const issued = refund.body as IRefundBody;
    expect(issued.status).toBe('issued');
    expect(issued.amountMinor).toBe(PARTIAL_MINOR);
    expect(issued.gatewayReference).not.toBeNull();
    firstRefundId = issued.id;

    // Partial refund: the payment row stays `captured`, the cumulative total is the partial
    // amount.
    const payment = await dataSource.getPaymentByOrderId(order.id);
    expect(payment?.status).toBe('captured');
    expect(payment?.refundedAmountMinor).toBe(PARTIAL_MINOR);
    expect((await getOrder(order.id)).payment?.status).toBe('captured');
  });

  it('double-issue idempotency: the SAME refund re-issued returns the same row, never doubling', async () => {
    const replay = await issueRefund(
      { paymentId, amountMinor: PARTIAL_MINOR, reason: PARTIAL_REASON },
      IDEMPOTENCY_KEY,
    );
    // The natural already-issued short-circuit returns the existing refund (201), not a new
    // one — same id, no second gateway charge.
    expect(replay.status).toBe(HttpStatus.CREATED);
    const replayed = replay.body as IRefundBody;
    expect(replayed.id).toBe(firstRefundId);
    expect(replayed.status).toBe('issued');

    // Only ONE effective refund took hold — the cumulative refund did not double.
    const payment = await dataSource.getPaymentByOrderId(order.id);
    expect(payment?.refundedAmountMinor).toBe(PARTIAL_MINOR);
    const refunds = await dataSource.getRefundsByOrderId(order.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].id).toBe(firstRefundId);
  });

  it('rejects an over-refund beyond the refundable remainder → 409 REFUND_EXCEEDS_REFUNDABLE', async () => {
    // The remaining refundable amount is 4000; asking for the full 5000 exceeds it.
    const over = await issueRefund(
      { paymentId, amountMinor: GRAND_TOTAL_MINOR, reason: 'Over the ceiling' },
      `manual-refund-${stamp}-over`,
    );
    expect(over.status).toBe(HttpStatus.CONFLICT);
    expect((over.body as IErrorBody).code).toBe('REFUND_EXCEEDS_REFUNDABLE');

    // The rejected over-refund moved nothing — the cumulative refund still equals the single
    // partial, never exceeding the captured amount.
    const payment = await dataSource.getPaymentByOrderId(order.id);
    expect(payment?.status).toBe('captured');
    expect(payment?.refundedAmountMinor).toBe(PARTIAL_MINOR);
  });

  it('issues the remaining refundable amount → the payment flips to refunded', async () => {
    const refund = await issueRefund(
      { paymentId, amountMinor: REMAINDER_MINOR, reason: 'Refund the remainder' },
      `manual-refund-${stamp}-remainder`,
    );
    expect(refund.status).toBe(HttpStatus.CREATED);
    expect((refund.body as IRefundBody).status).toBe('issued');

    // The cumulative refund now exhausts the captured total, so the payment row flips to
    // `refunded` and the cumulative equals the captured amount exactly (never more).
    const payment = await dataSource.getPaymentByOrderId(order.id);
    expect(payment?.status).toBe('refunded');
    expect(payment?.refundedAmountMinor).toBe(GRAND_TOTAL_MINOR);
    expect((await getOrder(order.id)).payment?.status).toBe('refunded');

    // Two issued refunds total (the partial + the remainder); the idempotent replay added
    // none.
    const refunds = await dataSource.getRefundsByOrderId(order.id);
    expect(refunds).toHaveLength(2);
    expect(refunds.every((r) => r.status === 'issued')).toBe(true);
    expect(refunds.reduce((sum, r) => sum + r.amountMinor, 0)).toBe(GRAND_TOTAL_MINOR);
  });
});
