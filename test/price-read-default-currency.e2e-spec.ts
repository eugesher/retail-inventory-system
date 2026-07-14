// **This assignment must run before the app modules are EVALUATED, and that is why they are pulled in
// with a dynamic `import()` below instead of a top-level one.**
// `ConfigModule.forRoot(configModuleConfig)` sits in a `@Module` decorator argument, so it loads
// dotenv and runs Joi at AppModule *import* time — and a static `import` is hoisted above every
// statement in the file, including this one. Setting the variable in `beforeAll` would be **too late,
// and the spec would pass while proving nothing** (the trap `test/jest.setup.ts` documents for
// `HEALTH_PROBE_TIMEOUT_MS`, and the one `test/cart-default-currency.e2e-spec.ts` already walks past).
process.env.DEFAULT_CURRENCY = 'EUR';

import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

// THE proof for ISSUE-11 — the **last** of the three `DEFAULT_CURRENCY` readers that never read it.
//
// `PriceQueryDto` carried `public currency = 'USD'`: a field initializer the global `ValidationPipe`
// (`transform: true`) keeps, so a caller who omitted `?currency=` had `USD` put on the wire for them.
// On a shop configured `DEFAULT_CURRENCY=EUR` the catalog holds **only EUR prices** —
// `PublishProductUseCase` will not publish a variant without an active price in
// `CATALOG_DEFAULT_CURRENCY` — so both `@Public()` price reads asked for a currency the catalog does
// not stock and **found nothing, for every variant**. `GET .../price` answered `200` with a `null`
// body; `GET .../prices` answered `[]`. **A correctly configured shop could not display a price.**
//
// This spec boots the real stack with `DEFAULT_CURRENCY=EUR`, publishes a variant priced in EUR, and
// asks for its price **without** `?currency=`. It must come back. On the parent commit it does not.
//
// **The variable is restored in `afterAll`, and that is not optional.** `process.env` lives in the
// Jest worker PROCESS, reused across spec files; a leaked `EUR` would make the next suite's catalog
// price its fixtures in a currency its assertions do not expect.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const PRICE_MINOR = 4599;

interface ITokenResponse {
  accessToken: string;
}

describe('Price reads follow DEFAULT_CURRENCY (e2e)', () => {
  const timeout = 90_000;
  const previousCurrency = process.env.DEFAULT_CURRENCY;

  let apiGatewayApp: INestApplication;
  let catalogMicroservice: INestMicroservice;

  const stamp = Date.now();
  let adminAuth: string;
  let variantId: number;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    const { AppModule: CatalogMicroserviceAppModule } =
      await import('@retail-inventory-system/apps/catalog-microservice');
    const { AppModule: ApiGatewayAppModule } =
      await import('@retail-inventory-system/apps/api-gateway');

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

    const { body: tokens } = await server()
      .post('/api/auth/staff/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminAuth = `Bearer ${(tokens as ITokenResponse).accessToken}`;

    // A variant priced in EUR — and ONLY in EUR, which is what a shop configured for EUR actually
    // looks like. There is no USD price to fall back on, and that is the point.
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Price Currency ${stamp}`,
        slug: `e2e-price-currency-${stamp}`,
        description: 'ISSUE-11 fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-PRCUR-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    variantId = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variantId}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'EUR', amountMinor: PRICE_MINOR });
    expect(priceRes.status).toBe(HttpStatus.CREATED);

    await settleTimestampRounding();

    // Publish proves the shop really is an EUR shop: the precondition probe demands an active price in
    // `CATALOG_DEFAULT_CURRENCY`, so this only succeeds because the catalog is reading EUR too.
    const publishRes = await server()
      .post(`/api/catalog/products/${productId}/publish`)
      .set('Authorization', adminAuth);
    expect(publishRes.status).toBe(HttpStatus.OK);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await catalogMicroservice?.close();
    process.env.DEFAULT_CURRENCY = previousCurrency;
  });

  // ═══ THE assertion ISSUE-11 exists for ═══
  it(
    'GET /price with no ?currency= returns the EUR price, not nothing',
    async () => {
      const res = await server().get(`/api/catalog/variants/${variantId}/price`);

      expect(res.status).toBe(HttpStatus.OK);
      // On the parent commit the body is `null`: the gateway asked for a USD price the catalog does not
      // stock, and the endpoint answered "no price in effect" for a variant that has one.
      expect(res.body).not.toBeNull();
      expect(res.body as { currency: string; amountMinor: number }).toMatchObject({
        currency: 'EUR',
        amountMinor: PRICE_MINOR,
      });
    },
    timeout,
  );

  it(
    'GET /prices with no ?currency= lists the EUR price, not an empty array',
    async () => {
      const res = await server().get(`/api/catalog/variants/${variantId}/prices`);

      expect(res.status).toBe(HttpStatus.OK);
      const prices = res.body as { currency: string }[];
      // On the parent commit this is `[]` — for every variant in the shop.
      expect(prices).toHaveLength(1);
      expect(prices[0].currency).toBe('EUR');
    },
    timeout,
  );

  it(
    'an explicit ?currency= still wins over the configured default',
    async () => {
      const res = await server().get(`/api/catalog/variants/${variantId}/price?currency=USD`);

      // There is no USD price, so the honest answer is "none in effect" — and the caller asked for it
      // explicitly, which is exactly the case the query parameter exists to serve. **This is also the
      // control**: it proves the endpoint really does scope by the currency it is given, so the EUR
      // answer above is not an artefact of the endpoint ignoring the scope altogether.
      //
      // Nest serialises a returned `null` as an EMPTY BODY (the route is documented as `200` with a
      // `null` body, not a 404), and supertest surfaces an empty body as `{}` — hence the shape of the
      // assertion. It carries no price, which is the fact under test.
      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toEqual({});
      expect(res.body).not.toHaveProperty('currency');
    },
    timeout,
  );

  it(
    'a malformed ?currency= is still rejected at the edge',
    async () => {
      // Making the field optional must not make it unvalidated — `@Matches` still guards the shape.
      const res = await server().get(`/api/catalog/variants/${variantId}/price?currency=eurozone`);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    },
    timeout,
  );
});
