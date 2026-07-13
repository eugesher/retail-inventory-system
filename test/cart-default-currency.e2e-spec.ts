// **This assignment must run before the app modules are EVALUATED, and that is why they are
// pulled in with a dynamic `import()` below instead of a top-level one.**
// `ConfigModule.forRoot(configModuleConfig)` sits in a `@Module` decorator argument, so it
// loads dotenv and runs Joi at AppModule *import* time — and a static `import` is hoisted
// above every statement in the file, including this one. Setting the variable in `beforeAll`
// would therefore be too late, and the spec would silently prove nothing (the same trap
// `test/jest.setup.ts` documents for `HEALTH_PROBE_TIMEOUT_MS`).
process.env.DEFAULT_CURRENCY = 'EUR';

import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

// THE proof that the cart's default currency is CONFIGURED, not literal (ISSUE-02).
//
// The unit spec pins that `CreateCartUseCase` honours the currency it is given. It cannot
// pin the thing that was actually broken: **the cart never asked the configuration at all.**
// It resolved the default from a file-local `const DEFAULT_CURRENCY = 'USD'`, so an operator
// who set `DEFAULT_CURRENCY=EUR` got a catalog quoting EUR and every new cart still opening
// in USD. `Cart.currency` is immutable (ADR-028 §1) and the order snapshots it at place-time
// into an immutable `Order.currency`, so the wrong unit was baked into the order and the
// payment and nothing downstream could tell. The amounts were right; the CURRENCY was wrong.
//
// This spec boots the real stack with `DEFAULT_CURRENCY=EUR` and asserts a cart opened with
// no currency comes back **EUR**. On `main` it comes back `USD` — the whole defect, in one
// assertion.
//
// **It restores the variable in `afterAll`, and that is not optional.** `process.env` lives
// in the Jest worker PROCESS, which is reused across spec files; a leaked `EUR` would make
// the next suite's catalog price its fixtures in a currency its assertions do not expect.
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

interface ITokenResponse {
  accessToken: string;
}

describe('Cart default currency follows DEFAULT_CURRENCY (e2e)', () => {
  const timeout = 60_000;
  const previousCurrency = process.env.DEFAULT_CURRENCY;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    const { AppModule: RetailMicroserviceAppModule } =
      await import('@retail-inventory-system/apps/retail-microservice');
    const { AppModule: ApiGatewayAppModule } =
      await import('@retail-inventory-system/apps/api-gateway');

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

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await apiGatewayApp.init();
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    process.env.DEFAULT_CURRENCY = previousCurrency;
  });

  it('opens a cart in EUR when the server is configured for EUR', async () => {
    const { body: tokens } = await server()
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    const token = (tokens as ITokenResponse).accessToken;

    // No `currency` in the body — the whole point is what the server picks.
    const response = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(HttpStatus.CREATED);
    expect((response.body as { currency: string }).currency).toBe('EUR');
  });

  it('an explicit currency still wins over the configured default', async () => {
    const { body: tokens } = await server()
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    const token = (tokens as ITokenResponse).accessToken;

    const response = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ currency: 'GBP' });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect((response.body as { currency: string }).currency).toBe('GBP');
  });
});
