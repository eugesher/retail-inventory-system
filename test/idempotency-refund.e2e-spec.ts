import { randomUUID } from 'crypto';

import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as EventStoreMicroserviceAppModule } from '@retail-inventory-system/apps/event-store-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { EventStoreE2ESpecDataSource } from './data-source/event-store.e2e-spec.data-source';
import { ReturnsRefundsE2ESpecDataSource } from './data-source/returns-refunds.e2e-spec.data-source';

// Idempotent Issue Refund (ADR-036) — the audit-integrity case. Refund is the one covered
// operation that ALWAYS writes an `audit_log_entry` (the always-audit money seam, ADR-032).
// A refund with an `Idempotency-Key`, replayed with the same key + body, returns the stored
// `RefundView` (HTTP 200 + `Idempotent-Replay: true`) BEFORE the gateway call AND before the
// audit emit — so one logical refund leaves exactly ONE refund row, does not double
// `refunded_amount_minor`, and — the distinguishing oracle — writes exactly ONE
// `audit.staff.action` into `ris_eventstore.audit_log_entry` (ADR-035). The two refund
// requests are driven under one fixed `x-correlation-id`, so the audit rows can be counted
// by that shared correlation id via direct SQL. The count is what the replay DID NOT emit,
// so it is read off the table rather than through `GET /api/audit/entries` — a write-path
// assertion must not depend on the read path, and this suite need not boot the event store's
// query transport to make it.
//
// Self-provisioned, disjoint fixture (`e2e-idem-refund-*`).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const CORRELATION_HEADER = 'x-correlation-id';
const REFUND_AUDIT_ACTION = 'RefundIssued';

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

interface IOrderBody {
  id: number;
  payment?: { id: number; status: string };
}

interface IRefundBody {
  id: number;
  amountMinor: number;
  status: string;
}

describe('Idempotent Issue Refund: replay does not re-refund or re-audit (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let eventStoreMicroservice: INestMicroservice;
  let eventStore: EventStoreE2ESpecDataSource;
  let retailDb: ReturnsRefundsE2ESpecDataSource;

  const stamp = Date.now();
  const correlationId = `idem-refund-${stamp}-${randomUUID()}`;
  const refundKey = `idem-refund-${stamp}`;
  const REFUND_AMOUNT = 700;

  let adminAuth: string;
  let customerToken: string;
  let variantId: number;
  let order: IOrderBody;
  let paymentId: number;
  let firstRefund: IRefundBody;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const waitForStockRow = async (variant: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await retailDb.getStockLevelRows(variant)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variant}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const refundAuditCount = async (): Promise<number> => {
    const rows = await eventStore.getAuditLogEntriesByCorrelationId(correlationId);
    return rows.filter((r) => r.action === REFUND_AUDIT_ACTION).length;
  };

  // Audit ingestion is asynchronous (publish → broker → consume → insert), so poll for the
  // first refund audit row before asserting the count.
  const waitForRefundAudit = async (deadlineMs = 30_000): Promise<void> => {
    const start = Date.now();
    while ((await refundAuditCount()) < 1) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for the ${REFUND_AUDIT_ACTION} audit entry`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const createMicroservice = (
    appModule: unknown,
    queue: MicroserviceQueueEnum,
  ): Promise<INestMicroservice> =>
    NestFactory.createMicroservice<MicroserviceOptions>(appModule as never, {
      logger: false,
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL!],
        queue,
        queueOptions: { durable: true },
      },
    });

  const issueRefund = (key: string): supertest.Test =>
    server()
      .post(`/api/orders/${order.id}/refunds`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', key)
      .set(CORRELATION_HEADER, correlationId)
      .send({ paymentId, amountMinor: REFUND_AMOUNT, reason: 'Goodwill adjustment' });

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    retailMicroservice = await createMicroservice(
      RetailMicroserviceAppModule,
      MicroserviceQueueEnum.RETAIL_QUEUE,
    );
    catalogMicroservice = await createMicroservice(
      CatalogMicroserviceAppModule,
      MicroserviceQueueEnum.CATALOG_QUEUE,
    );
    inventoryMicroservice = await createMicroservice(
      InventoryMicroserviceAppModule,
      MicroserviceQueueEnum.INVENTORY_QUEUE,
    );

    eventStoreMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      EventStoreMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          noAck: false,
          queue: MicroserviceQueueEnum.EVENT_STORE_FIREHOSE_QUEUE,
          queueOptions: { durable: true },
          exchange: 'ris.events',
          exchangeType: 'topic',
          wildcards: true,
        },
      },
    );

    await Promise.all([
      retailMicroservice.listen(),
      catalogMicroservice.listen(),
      inventoryMicroservice.listen(),
      eventStoreMicroservice.listen(),
    ]);

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    eventStore = new EventStoreE2ESpecDataSource({
      type: 'mysql',
      url: process.env.EVENTSTORE_DATABASE_URL!,
      timezone: 'Z',
    });
    await eventStore.initialize();

    retailDb = new ReturnsRefundsE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await retailDb.initialize();

    const adminLogin = await server()
      .post('/api/auth/staff/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminAuth = `Bearer ${(adminLogin.body as ITokenResponse).accessToken}`;

    const customerLogin = await server()
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    customerToken = (customerLogin.body as ITokenResponse).accessToken;

    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Idem Refund ${stamp}`,
        slug: `e2e-idem-refund-${stamp}`,
        description: 'idempotent refund fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-IDEMREF-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    variantId = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variantId}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 2000 });
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
      .send({ quantity: 5 });
    expect(receiveRes.status).toBe(HttpStatus.OK);

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
      .set('Idempotency-Key', `idem-refund-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    order = place.body as IOrderBody;

    // Capture so the payment is refundable.
    const capture = await server()
      .post(`/api/orders/${order.id}/payments/capture`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `idem-refund-${stamp}-capture`)
      .send({});
    expect(capture.status).toBe(HttpStatus.OK);
    order = capture.body as IOrderBody;
    paymentId = order.payment!.id;
    expect(order.payment?.status).toBe('captured');
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await eventStoreMicroservice?.close();
    await eventStore?.destroy();
    await retailDb?.destroy();
  });

  it('the first refund issues (201) and writes one audit entry', async () => {
    const res = await issueRefund(refundKey);
    expect(res.status).toBe(HttpStatus.CREATED);
    expect(res.headers['idempotent-replay']).toBeUndefined();

    firstRefund = res.body as IRefundBody;
    expect(firstRefund.status).toBe('issued');
    expect(firstRefund.amountMinor).toBe(REFUND_AMOUNT);

    const payment = await retailDb.getPaymentByOrderId(order.id);
    expect(payment?.refundedAmountMinor).toBe(REFUND_AMOUNT);

    await waitForRefundAudit();
  });

  it('the replay returns the stored refund (200 + Idempotent-Replay) with the same id', async () => {
    const res = await issueRefund(refundKey);
    expect(res.status).toBe(HttpStatus.OK);
    expect(res.headers['idempotent-replay']).toBe('true');
    expect((res.body as IRefundBody).id).toBe(firstRefund.id);
  });

  it('exactly one refund row and no doubled refunded_amount_minor after the replay', async () => {
    const refunds = await retailDb.getRefundsByOrderId(order.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].id).toBe(firstRefund.id);

    const payment = await retailDb.getPaymentByOrderId(order.id);
    expect(payment?.refundedAmountMinor).toBe(REFUND_AMOUNT);
  });

  it('exactly one RefundIssued audit_log_entry despite the replay (the replay short-circuited before the audit)', async () => {
    // Settle so a (wrong) second audit emission would have been ingested before the count.
    await settleTimestampRounding();
    expect(await refundAuditCount()).toBe(1);
  });
});
