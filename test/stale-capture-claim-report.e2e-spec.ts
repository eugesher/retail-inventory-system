import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum, PaymentStatusEnum } from '@retail-inventory-system/contracts';

import { ReportStaleCaptureClaimsUseCase } from '../apps/retail-microservice/src/modules/orders/application/use-cases';
import { CaptureClaimE2ESpecDataSource } from './data-source/capture-claim.e2e-spec.data-source';

// **The query behind the stranded-claim report, run against MySQL for the first time (ADR-052).**
//
// `ReportStaleCaptureClaimsUseCase` is unit-tested — against an in-memory double. What was never
// executed by anything is `PaymentTypeormRepository.listStaleCaptureClaims`, the SQL that actually
// finds a stranded claim. That matters more than a coverage percentage suggests: **this reporter is
// the ONLY thing that will ever tell an operator a payment's fate is unknown.** If its query silently
// matches nothing — a status predicate that never fires, a horizon comparison skewed by a timezone —
// the system does not fail. It reports zero stranded claims, forever, exactly as it would if there
// were none. A monitor that cannot distinguish "nothing is wrong" from "I am broken" is worse than no
// monitor, because somebody trusts it.
//
// So this spec proves three things the unit test structurally cannot:
//
//   1. a genuinely stranded `capturing` row IS found (the status predicate and the mapper work);
//   2. a FRESH `capturing` row is NOT (the horizon predicate is real — without this, a query that
//      forgot `updated_at` entirely would still pass (1));
//   3. an `authorized` row is NOT (the status predicate is real, symmetrically).
//
// And a fourth, which is the decision rather than the mechanism: **the report resolves nothing.** The
// row is still `capturing` afterwards. That is not an unfinished sweeper — `IPaymentGatewayPort` has
// no "did my capture land?" query, so releasing the claim would invite a second charge and completing
// it would record money that may never have moved (ADR-052, and the one entry in the ADR-053 register).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

// `CAPTURE_CLAIM_STALE_MINUTES` (Joi default 15). The fixtures sit well clear of it on both sides so
// the test is not a race against the clock: 60 minutes is unambiguously stale, 0 unambiguously fresh.
const STALE_MINUTES = 60;
const FRESH_MINUTES = 0;

const ADDRESS = {
  recipientName: 'Stranded Claim',
  line1: '1 Market St',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94105',
  country: 'US',
};

interface ITokenResponse {
  accessToken: string;
}

describe('Stranded capture claims — the report finds them, and resolves none (e2e)', () => {
  const timeout = 120_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: CaptureClaimE2ESpecDataSource;
  let report: ReportStaleCaptureClaimsUseCase;

  const stamp = Date.now();
  let adminAuth: string;
  let customerToken: string;
  let variantId: number;
  let orderId: number;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const customerLogin = async (): Promise<string> => {
    const { body } = await server()
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    return (body as ITokenResponse).accessToken;
  };

  const waitForStockRow = async (variant: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelCount(variant)) === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for the auto-init stock_level row for ${variant}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const provisionVariant = async (onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Stranded Claim ${stamp}`,
        slug: `e2e-stranded-claim-${stamp}`,
        description: 'ADR-052 fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-STRAND-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variant = (variantRes.body as { id: number }).id;

    await server()
      .post(`/api/catalog/variants/${variant}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });

    // The pricing publish probe compares `price.valid_from` against `UTC_TIMESTAMP()`, which is a
    // whole second's resolution — publish too fast and the price is not yet "active".
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await server()
      .post(`/api/catalog/products/${productId}/publish`)
      .set('Authorization', adminAuth);

    await waitForStockRow(variant);

    await server()
      .post(`/api/inventory/variants/${variant}/stock/receive`)
      .set('Authorization', adminAuth)
      .send({ quantity: onHand });

    return variant;
  };

  // A placed order, authorized-on-place: `payment.status = 'authorized'`, nothing captured.
  const placeOrder = async (): Promise<number> => {
    const cartRes = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    const cartId = (cartRes.body as { id: string }).id;

    await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: 1 });

    const placeRes = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `strand-place-${stamp}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(placeRes.status).toBe(HttpStatus.CREATED);
    return (placeRes.body as { id: number }).id;
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

    // The use case as the SCHEDULER will call it — resolved out of the retail container, wired to the
    // real `PaymentTypeormRepository` and the real `CAPTURE_CLAIM_STALE_MINUTES`. Reaching for it
    // directly (rather than through an RPC) is deliberate: it has no route and no message pattern, and
    // it should not grow one — a cron and an operator's `SELECT` are its only two callers.
    report = retailMicroservice.get(ReportStaleCaptureClaimsUseCase, { strict: false });

    dataSource = new CaptureClaimE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);
    customerToken = await customerLogin();
    variantId = await provisionVariant(5);
    orderId = await placeOrder();
  }, timeout);

  afterAll(async () => {
    await dataSource?.destroy();
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
  }, timeout);

  // Every assertion is a DELTA against a baseline taken in the same test, never an absolute count. The
  // e2e suite shares one database and runs serially, so an absolute `toBe(1)` would be a hostage to
  // whatever any other spec left behind.
  it(
    'finds a claim that has been open past the horizon',
    async () => {
      const before = await report.execute();

      await dataSource.strandCaptureClaim(orderId, STALE_MINUTES);

      const after = await report.execute();
      expect(after).toBe(before + 1);
    },
    timeout,
  );

  // **The horizon is a real predicate, not decoration.** A `listStaleCaptureClaims` that filtered on
  // `status` alone would pass the test above and fail this one — and in production it would page an
  // operator about every capture in flight, which is the fastest way to teach them to ignore the alert.
  it(
    'does NOT report a claim that was opened a moment ago',
    async () => {
      await dataSource.strandCaptureClaim(orderId, FRESH_MINUTES);

      const baseline = await report.execute();

      // Age it past the horizon and the same row appears — proving the row was eligible in every
      // respect EXCEPT its age, so it is the age that excluded it.
      await dataSource.strandCaptureClaim(orderId, STALE_MINUTES);
      expect(await report.execute()).toBe(baseline + 1);
    },
    timeout,
  );

  // **The report resolves NOTHING, and that is the design (ADR-052).** Nothing here knows whether the
  // money moved: releasing the claim would let the next caller charge again, and completing it would
  // record a charge that may never have happened. So a stranded row survives its own report, and the
  // only thing that resolves it is a human with the `gatewayReference` the log line carries.
  //
  // The day a real gateway is bound — one with a capture-status query — this becomes a true reconciler.
  // That obligation is registered, owned and dated in `spec/transition-windows.spec.ts` (ADR-053), which
  // goes red on 2027-01-13 whether or not anybody remembers.
  it(
    'leaves the stranded row exactly as it found it',
    async () => {
      await dataSource.strandCaptureClaim(orderId, STALE_MINUTES);

      await report.execute();

      const payment = await dataSource.getPayment(orderId);
      expect(payment?.status).toBe(PaymentStatusEnum.CAPTURING);
      expect(payment?.captured_at).toBeNull();
    },
    timeout,
  );

  // The symmetric proof for the STATUS predicate — and it only works because the row is left **old**.
  //
  // The obvious way to write this is `UPDATE payment SET status = 'authorized'` and expect the row to
  // vanish from the report. That version passes, and it proves nothing: the bare `UPDATE` re-stamps
  // `updated_at` to `NOW()` through the column's `ON UPDATE CURRENT_TIMESTAMP`, so the row leaves the
  // report via the HORIZON, and a query that had lost its status filter altogether would exclude it too.
  // (Verified by mutation: deleting `WHERE status = 'capturing'` from the repository left every test in
  // this file green.)
  //
  // Ageing the row to the same 60 minutes removes the horizon as an explanation. If the report still
  // counts it, the status predicate is not doing its job.
  it(
    'does NOT report an authorized payment, even one this old',
    async () => {
      await dataSource.strandCaptureClaim(orderId, STALE_MINUTES);
      const withClaim = await report.execute();

      await dataSource.agePayment(orderId, PaymentStatusEnum.AUTHORIZED, STALE_MINUTES);

      expect(await report.execute()).toBe(withClaim - 1);
    },
    timeout,
  );
});
