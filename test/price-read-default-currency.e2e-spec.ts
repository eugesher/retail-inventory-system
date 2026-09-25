process.env.DEFAULT_CURRENCY = 'EUR';

import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

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

  it(
    'GET /price with no ?currency= returns the EUR price, not nothing',
    async () => {
      const res = await server().get(`/api/catalog/variants/${variantId}/price`);

      expect(res.status).toBe(HttpStatus.OK);
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
      expect(prices).toHaveLength(1);
      expect(prices[0].currency).toBe('EUR');
    },
    timeout,
  );

  it(
    'an explicit ?currency= still wins over the configured default',
    async () => {
      const res = await server().get(`/api/catalog/variants/${variantId}/price?currency=USD`);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toEqual({});
      expect(res.body).not.toHaveProperty('currency');
    },
    timeout,
  );

  it(
    'a malformed ?currency= is still rejected at the edge',
    async () => {
      const res = await server().get(`/api/catalog/variants/${variantId}/price?currency=eurozone`);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    },
    timeout,
  );
});
