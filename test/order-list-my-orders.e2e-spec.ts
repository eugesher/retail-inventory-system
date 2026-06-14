import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

// Seeded staff fixture with the `order-support` role — it carries `order:read`, the
// staff override that reads any order regardless of ownership.
const STAFF_EMAIL = 'support@example.com';
const STAFF_PASSWORD = 'support1234';

// A seeded, priced variant (USD 4999) so a placed order has a real line total.
const VARIANT_ID = 1;

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

interface IOrderBody {
  id: number;
  orderNumber: string;
  customerId: string;
}

interface IOrderPageBody {
  items: IOrderBody[];
  total: number;
  page: number;
  size: number;
}

describe('List My Orders (e2e)', () => {
  const timeout = 60_000;
  // Unique per run so the spec stays re-runnable against already-migrated infra
  // (`yarn test:e2e:run`) without colliding on the customer email UNIQUE.
  const suffix = Date.now();

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  // Each placed order reserves (add-to-cart) then allocates (place), so the
  // inventory microservice must be up to serve `inventory.reservation.*`.
  let inventoryMicroservice: INestMicroservice;

  const registerAndLogin = async (email: string, password: string): Promise<string> => {
    await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/customer/register')
      .send({ email, password, firstName: 'List', lastName: 'Tester' });
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/customer/login')
      .send({ email, password });
    return (body as ITokenResponse).accessToken;
  };

  const staffLogin = async (): Promise<string> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/staff/login')
      .send({ email: STAFF_EMAIL, password: STAFF_PASSWORD });
    return (body as ITokenResponse).accessToken;
  };

  // Builds a one-line cart and places it, returning the placed order body.
  const placeOneOrder = async (accessToken: string): Promise<IOrderBody> => {
    const create = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/cart')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currency: 'USD' });
    const cartId = (create.body as { id: string }).id;

    await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ variantId: VARIANT_ID, quantity: 1 });

    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', `${suffix}-${cartId}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS });
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
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
  });

  describe('own-only listing with a staff override', () => {
    let customerAToken: string;
    let customerBToken: string;
    let firstOrder: IOrderBody;
    let secondOrder: IOrderBody;

    it('places two orders for customer A', async () => {
      customerAToken = await registerAndLogin(`list-a-${suffix}@example.com`, 'listtester1234');
      firstOrder = await placeOneOrder(customerAToken);
      secondOrder = await placeOneOrder(customerAToken);

      expect(firstOrder.id).toEqual(expect.any(Number));
      expect(secondOrder.id).toBeGreaterThan(firstOrder.id);
    });

    it('GET /api/orders returns both of customer A’s orders, newest-first', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/orders?page=1&pageSize=10')
        .set('Authorization', `Bearer ${customerAToken}`);

      expect(status).toBe(HttpStatus.OK);
      const page = body as IOrderPageBody;
      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(2);
      // Newest-first: the second order placed comes first.
      expect(page.items[0].id).toBe(secondOrder.id);
      expect(page.items[1].id).toBe(firstOrder.id);
      expect(page.items.every((order) => order.customerId === firstOrder.customerId)).toBe(true);
    });

    it('a second customer’s GET /api/orders does not see customer A’s orders', async () => {
      customerBToken = await registerAndLogin(`list-b-${suffix}@example.com`, 'listtester1234');

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/orders')
        .set('Authorization', `Bearer ${customerBToken}`);

      expect(status).toBe(HttpStatus.OK);
      const page = body as IOrderPageBody;
      expect(page.total).toBe(0);
      expect(page.items).toHaveLength(0);
    });

    it('a non-owner customer GETting another’s order is 403', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .get(`/api/orders/${firstOrder.id}`)
        .set('Authorization', `Bearer ${customerBToken}`);

      expect(status).toBe(HttpStatus.FORBIDDEN);
    });

    it('a staff token with order:read can GET any order (the staff override)', async () => {
      const staffToken = await staffLogin();

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get(`/api/orders/${firstOrder.id}`)
        .set('Authorization', `Bearer ${staffToken}`);

      expect(status).toBe(HttpStatus.OK);
      expect((body as IOrderBody).id).toBe(firstOrder.id);
    });

    it('an unauthenticated GET /api/orders is 401', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer()).get('/api/orders');
      expect(status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });
});
