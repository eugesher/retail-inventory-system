process.env.DEFAULT_CURRENCY = 'EUR';

import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

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
