import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

const CUSTOMER_PASSWORD = 'customer1234';
const SEEDED_VARIANT_ID = 1;

interface IGuestSessionResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  customerId: string;
}

interface ITokenResponse {
  accessToken: string;
}

interface ICartBody {
  id: string;
  customerId: string | null;
  lines: { id: number; variantId: number; quantity: number }[];
}

const registeredEmail = (): string =>
  `claimer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

describe('Guest cart promotion (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;

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
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
  });

  it('promotes a guest cart to a registered customer via claim', async () => {
    const guestSession = await supertest(apiGatewayApp.getHttpServer()).post(
      '/api/auth/customer/guest-session',
    );
    expect(guestSession.status).toBe(HttpStatus.CREATED);
    const guest = guestSession.body as IGuestSessionResponse;
    expect(guest.accessToken).toEqual(expect.any(String));
    expect(guest.customerId).toEqual(expect.any(String));
    const guestToken = guest.accessToken;
    const guestId = guest.customerId;

    const create = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/cart')
      .set('Authorization', `Bearer ${guestToken}`)
      .send({ currency: 'USD' });
    expect(create.status).toBe(HttpStatus.CREATED);
    const cart = create.body as ICartBody;
    expect(cart.customerId).toBe(guestId);
    const cartId = cart.id;

    const add = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${guestToken}`)
      .send({ variantId: SEEDED_VARIANT_ID, quantity: 1 });
    expect(add.status).toBe(HttpStatus.OK);
    expect((add.body as ICartBody).lines).toHaveLength(1);

    const email = registeredEmail();
    await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/customer/register')
      .send({ email, password: CUSTOMER_PASSWORD });
    const loginRes = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/customer/login')
      .send({ email, password: CUSTOMER_PASSWORD });
    const registeredToken = (loginRes.body as ITokenResponse).accessToken;

    const claim = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/cart/${cartId}/claim`)
      .set('Authorization', `Bearer ${registeredToken}`)
      .send({ fromCustomerId: guestId });
    expect(claim.status).toBe(HttpStatus.OK);
    expect((claim.body as ICartBody).lines).toHaveLength(1);

    const ownerGet = await supertest(apiGatewayApp.getHttpServer())
      .get(`/api/cart/${cartId}`)
      .set('Authorization', `Bearer ${registeredToken}`);
    expect(ownerGet.status).toBe(HttpStatus.OK);

    const guestGet = await supertest(apiGatewayApp.getHttpServer())
      .get(`/api/cart/${cartId}`)
      .set('Authorization', `Bearer ${guestToken}`);
    expect(guestGet.status).toBe(HttpStatus.FORBIDDEN);
  });

  it('rejects a claim whose fromCustomerId does not own the cart (403)', async () => {
    const guestSession = await supertest(apiGatewayApp.getHttpServer()).post(
      '/api/auth/customer/guest-session',
    );
    const guest = guestSession.body as IGuestSessionResponse;

    const create = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/cart')
      .set('Authorization', `Bearer ${guest.accessToken}`)
      .send({});
    const cartId = (create.body as ICartBody).id;

    const email = registeredEmail();
    await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/customer/register')
      .send({ email, password: CUSTOMER_PASSWORD });
    const loginRes = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/customer/login')
      .send({ email, password: CUSTOMER_PASSWORD });
    const registeredToken = (loginRes.body as ITokenResponse).accessToken;

    const claim = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/cart/${cartId}/claim`)
      .set('Authorization', `Bearer ${registeredToken}`)
      .send({ fromCustomerId: '00000000-0000-4000-a000-0000000000ff' });

    expect(claim.status).toBe(HttpStatus.FORBIDDEN);
  });
});
