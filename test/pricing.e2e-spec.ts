import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { PricingE2ESpecDataSource } from './data-source/pricing.e2e-spec.data-source';

// Seeded staff users (scripts/test-db-seed.ts). `admin` carries every permission
// (incl. `pricing:write`); `warehouse` carries only `inventory:*` — no pricing
// code — so it is the staff negative fixture for the write gate. A freshly
// registered customer carries no `permissions` claim at all, so any code-gated
// route is staff-only by construction (ADR-024).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_PASSWORD = 'customer1234';

interface ITokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface IProductBody {
  id: number;
  slug: string;
  status: string;
}

interface IVariantBody {
  id: number;
  productId: number;
  sku: string;
}

interface IPriceBody {
  id: number;
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom: string;
  validTo: string | null;
  priority: number;
}

interface ITaxCategoryBody {
  id: number;
  code: string;
  name: string;
  description: string | null;
}

interface IVariantTaxHeaderBody {
  variantId: number;
  sku: string;
  taxCategoryId: number | null;
  taxCategoryCode: string | null;
}

describe('Pricing gateway endpoints (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let catalogMicroservice: INestMicroservice;
  let dataSource: PricingE2ESpecDataSource;

  // Stamped so the flow stays idempotent under `yarn test:e2e:run` against an
  // already-seeded DB: a fresh slug/sku/tax-code set every run.
  const stamp = Date.now();
  const productSlug = `e2e-pricing-chair-${stamp}`;
  const skuA = `E2E-PRICE-A-${stamp}`;
  const skuB = `E2E-PRICE-B-${stamp}`;
  const taxCode = `STD_${stamp}`;

  let productId: number;
  const variantIds: number[] = [];
  // The persisted USD prices captured from the Set responses — their server-side
  // `validFrom` instants anchor the as-of / historic assertions below.
  let priceA0: IPriceBody;
  let priceB0: IPriceBody;

  const AMOUNT_A0 = 1999;
  const AMOUNT_B0 = 2999;
  const AMOUNT_A_FUTURE = 2499;
  const AMOUNT_B1 = 3499;

  const server = () => supertest(apiGatewayApp.getHttpServer());

  // The `price.valid_from` column is second-granular (`TIMESTAMP(0)`), so MySQL
  // rounds the domain's sub-second `validFrom` to the nearest whole second — a
  // freshly-set immediate price can round *up* and momentarily sit one second in
  // the future, which the publish precondition probe (`valid_from <=
  // UTC_TIMESTAMP()`) would read as "no active price". Waiting just over a second
  // lets that rounded second elapse — the realistic "price first, publish later"
  // gap — so the precondition is deterministically met.
  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  // Register a fresh customer and log in for a customer-tier access token (it
  // carries an empty `permissions` claim — the write-gate negative fixture).
  const customerBearer = async (): Promise<string> => {
    const email = `buyer-${stamp}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    await server().post('/api/auth/customer/register').send({ email, password: CUSTOMER_PASSWORD });
    const { body } = await server()
      .post('/api/auth/customer/login')
      .send({ email, password: CUSTOMER_PASSWORD });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const registerProduct = async (auth: string, slug: string): Promise<number> => {
    const { body } = await server()
      .post('/api/catalog/products')
      .set('Authorization', auth)
      .send({ name: `E2E Pricing ${slug}`, slug });
    return (body as IProductBody).id;
  };

  const addVariant = async (auth: string, ofProductId: number, sku: string): Promise<number> => {
    const { body } = await server()
      .post(`/api/catalog/products/${ofProductId}/variants`)
      .set('Authorization', auth)
      .send({ sku, optionValues: { color: 'black', size: 'M' } });
    return (body as IVariantBody).id;
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

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();

    dataSource = new PricingE2ESpecDataSource({ type: 'mysql', url: process.env.DATABASE_URL! });
    await dataSource.initialize();
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await catalogMicroservice?.close();
    await dataSource?.destroy();
  });

  describe('publish precondition → set price → publish → read', () => {
    it('admin registers a draft product with two variants', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      productId = await registerProduct(auth, productSlug);
      variantIds.push(await addVariant(auth, productId, skuA));
      variantIds.push(await addVariant(auth, productId, skuB));

      expect(typeof productId).toBe('number');
      expect(variantIds).toHaveLength(2);
    });

    it('publishing with no price hard-fails 409 and the product stays draft', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const publish = await server()
        .post(`/api/catalog/products/${productId}/publish`)
        .set('Authorization', auth);

      expect(publish.status).toBe(HttpStatus.CONFLICT);

      // The product must not have transitioned — get-by-slug resolves it
      // regardless of status (ADR-025), so we can read its lifecycle back.
      const { status, body } = await server().get(`/api/catalog/products/${productSlug}`);
      expect(status).toBe(HttpStatus.OK);
      expect((body as IProductBody).status).toBe('draft');
    });

    it('admin sets a USD price for each variant (201 PriceView)', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const resA = await server()
        .post(`/api/catalog/variants/${variantIds[0]}/prices`)
        .set('Authorization', auth)
        .send({ currency: 'USD', amountMinor: AMOUNT_A0 });
      expect(resA.status).toBe(HttpStatus.CREATED);
      priceA0 = resA.body as IPriceBody;
      expect(priceA0.amountMinor).toBe(AMOUNT_A0);
      expect(priceA0.currency).toBe('USD');
      expect(priceA0.validTo).toBeNull();

      const resB = await server()
        .post(`/api/catalog/variants/${variantIds[1]}/prices`)
        .set('Authorization', auth)
        .send({ currency: 'USD', amountMinor: AMOUNT_B0 });
      expect(resB.status).toBe(HttpStatus.CREATED);
      priceB0 = resB.body as IPriceBody;
      expect(priceB0.amountMinor).toBe(AMOUNT_B0);
      expect(priceB0.validTo).toBeNull();
    });

    it('admin publishes the now-priced product (draft → active)', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);
      await settleTimestampRounding();

      const { status, body } = await server()
        .post(`/api/catalog/products/${productId}/publish`)
        .set('Authorization', auth);

      expect(status).toBe(HttpStatus.OK);
      expect((body as IProductBody).status).toBe('active');
    });

    it('an anonymous shopper reads the current applicable price', async () => {
      const { status, body } = await server()
        .get(`/api/catalog/variants/${variantIds[0]}/price`)
        .query({ currency: 'USD' });

      expect(status).toBe(HttpStatus.OK);
      expect((body as IPriceBody).amountMinor).toBe(AMOUNT_A0);
    });
  });

  describe('scheduling: a future price leaves the current answer unchanged', () => {
    it('schedules a higher-priority future price (now+1h) for variant A', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);
      const futureValidFrom = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const { status, body } = await server()
        .post(`/api/catalog/variants/${variantIds[0]}/prices`)
        .set('Authorization', auth)
        .send({
          currency: 'USD',
          amountMinor: AMOUNT_A_FUTURE,
          validFrom: futureValidFrom,
          priority: 10,
        });

      expect(status).toBe(HttpStatus.CREATED);
      const scheduled = body as IPriceBody;
      // The scheduled row is the new open row (the immediate predecessor was
      // closed at its start). `validFrom` is asserted via behavior below, not by
      // exact-string equality — the second-granular column rounds the sub-second
      // instant we sent.
      expect(scheduled.amountMinor).toBe(AMOUNT_A_FUTURE);
      expect(scheduled.priority).toBe(10);
      expect(scheduled.validTo).toBeNull();
      const driftMs = Math.abs(
        new Date(scheduled.validFrom).getTime() - new Date(futureValidFrom).getTime(),
      );
      expect(driftMs).toBeLessThan(1_000);
    });

    it('the current applicable price is still the original', async () => {
      const { status, body } = await server()
        .get(`/api/catalog/variants/${variantIds[0]}/price`)
        .query({ currency: 'USD' });

      expect(status).toBe(HttpStatus.OK);
      expect((body as IPriceBody).amountMinor).toBe(AMOUNT_A0);
    });

    it('an as-of after the schedule resolves to the future price', async () => {
      const asOf = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      const { status, body } = await server()
        .get(`/api/catalog/variants/${variantIds[0]}/price`)
        .query({ currency: 'USD', asOf });

      expect(status).toBe(HttpStatus.OK);
      expect((body as IPriceBody).amountMinor).toBe(AMOUNT_A_FUTURE);
    });
  });

  describe('append-and-close: a new immediate price closes the predecessor', () => {
    it('sets a new immediate USD price for variant B', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await server()
        .post(`/api/catalog/variants/${variantIds[1]}/prices`)
        .set('Authorization', auth)
        .send({ currency: 'USD', amountMinor: AMOUNT_B1 });

      expect(status).toBe(HttpStatus.CREATED);
      const newPrice = body as IPriceBody;
      expect(newPrice.amountMinor).toBe(AMOUNT_B1);
      expect(newPrice.validTo).toBeNull();

      // Read the ledger as-of the original `validFrom`: only the predecessor is
      // in effect then, and it is now closed exactly at the new row's start
      // (half-open tiling, ADR-026).
      const list = await server()
        .get(`/api/catalog/variants/${variantIds[1]}/prices`)
        .query({ currency: 'USD', asOf: priceB0.validFrom });
      expect(list.status).toBe(HttpStatus.OK);
      const rows = list.body as IPriceBody[];
      const predecessor = rows.find((p) => p.amountMinor === AMOUNT_B0);
      expect(predecessor).toBeDefined();
      expect(predecessor?.validTo).toBe(newPrice.validFrom);
    });

    it('a historic as-of still resolves to the old price', async () => {
      const { status, body } = await server()
        .get(`/api/catalog/variants/${variantIds[1]}/price`)
        .query({ currency: 'USD', asOf: priceB0.validFrom });

      expect(status).toBe(HttpStatus.OK);
      expect((body as IPriceBody).amountMinor).toBe(AMOUNT_B0);
    });
  });

  describe('tax categories: create → list → attach to a variant', () => {
    let taxCategory: ITaxCategoryBody;

    it('admin creates a tax category (201)', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await server()
        .post('/api/catalog/tax-categories')
        .set('Authorization', auth)
        .send({ code: taxCode, name: 'Standard rate', description: 'E2E fixture' });

      expect(status).toBe(HttpStatus.CREATED);
      taxCategory = body as ITaxCategoryBody;
      expect(taxCategory.code).toBe(taxCode);
      expect(typeof taxCategory.id).toBe('number');
    });

    it('a duplicate code is rejected with 409', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status } = await server()
        .post('/api/catalog/tax-categories')
        .set('Authorization', auth)
        .send({ code: taxCode, name: 'Duplicate' });

      expect(status).toBe(HttpStatus.CONFLICT);
    });

    it('an anonymous caller lists the tax categories', async () => {
      const { status, body } = await server().get('/api/catalog/tax-categories');

      expect(status).toBe(HttpStatus.OK);
      expect((body as ITaxCategoryBody[]).some((t) => t.code === taxCode)).toBe(true);
    });

    it('admin attaches the tax category to a variant (200 header view)', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await server()
        .patch(`/api/catalog/variants/${variantIds[0]}/tax-category`)
        .set('Authorization', auth)
        .send({ taxCategoryCode: taxCode });

      expect(status).toBe(HttpStatus.OK);
      const header = body as IVariantTaxHeaderBody;
      expect(header.variantId).toBe(variantIds[0]);
      expect(header.taxCategoryCode).toBe(taxCode);
      expect(header.taxCategoryId).toBe(taxCategory.id);
    });
  });

  describe('concurrency: at most one open row survives two racing Sets', () => {
    it('two concurrent Sets for one scope leave exactly one open price', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const raceSlug = `e2e-pricing-race-${stamp}`;
      const raceProductId = await registerProduct(auth, raceSlug);
      const raceVariantId = await addVariant(auth, raceProductId, `E2E-RACE-${stamp}`);

      const fire = (amountMinor: number) =>
        server()
          .post(`/api/catalog/variants/${raceVariantId}/prices`)
          .set('Authorization', auth)
          .send({ currency: 'USD', amountMinor });

      const responses = await Promise.all([fire(5000), fire(6000)]);
      const statuses = responses.map((r) => r.status as HttpStatus);

      // The invariant the `open_scope_key` UNIQUE backstop + the
      // close-in-transaction guarantee: never two open rows for one scope.
      const openRows = await dataSource.countOpenPrices(raceVariantId, 'USD');
      expect(openRows).toBe(1);

      // At least one Set wins cleanly; any loser is a clear error (never a
      // silent second open row), so every response is a success or a >= 400.
      expect(statuses.filter((s) => s === HttpStatus.CREATED).length).toBeGreaterThanOrEqual(1);
      expect(statuses.every((s) => s === HttpStatus.CREATED || Number(s) >= 400)).toBe(true);
    });
  });

  describe('authorization gates', () => {
    it('a staff user without pricing:write gets 403 on Set price', async () => {
      const auth = await bearer('warehouse@example.com', 'warehouse1234');

      const { status } = await server()
        .post(`/api/catalog/variants/${variantIds[0]}/prices`)
        .set('Authorization', auth)
        .send({ currency: 'USD', amountMinor: 100 });

      expect(status).toBe(HttpStatus.FORBIDDEN);
    });

    it('a customer token (no permissions) gets 403 on Set price', async () => {
      const auth = await customerBearer();

      const { status } = await server()
        .post(`/api/catalog/variants/${variantIds[0]}/prices`)
        .set('Authorization', auth)
        .send({ currency: 'USD', amountMinor: 100 });

      expect(status).toBe(HttpStatus.FORBIDDEN);
    });

    it('an unauthenticated Set price gets 401', async () => {
      const { status } = await server()
        .post(`/api/catalog/variants/${variantIds[0]}/prices`)
        .send({ currency: 'USD', amountMinor: 100 });

      expect(status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('the price reads are public (200 without a token)', async () => {
      const list = await server()
        .get(`/api/catalog/variants/${variantIds[0]}/prices`)
        .query({ currency: 'USD' });
      expect(list.status).toBe(HttpStatus.OK);

      const single = await server()
        .get(`/api/catalog/variants/${variantIds[0]}/price`)
        .query({ currency: 'USD' });
      expect(single.status).toBe(HttpStatus.OK);
    });
  });
});
