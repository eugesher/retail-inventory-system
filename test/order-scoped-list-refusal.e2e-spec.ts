import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { InventoryAutoInitE2ESpecDataSource } from './data-source/inventory-auto-init.e2e-spec.data-source';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const OWNER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

const ADDRESS = {
  recipientName: 'List Refusal',
  line1: '1 Market St',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94105',
  country: 'US',
};

interface ITokenResponse {
  accessToken: string;
}

describe('Order-scoped lists refuse a non-owner identically (e2e)', () => {
  const timeout = 90_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: InventoryAutoInitE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let ownerToken: string;
  let strangerToken: string;
  let orderId: number;

  const listRoutes = (id: number): string[] => [
    `/api/orders/${id}/returns`,
    `/api/orders/${id}/refunds`,
    `/api/orders/${id}/fulfillments`,
  ];

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const customerLogin = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/customer/login').send({ email, password });
    return (body as ITokenResponse).accessToken;
  };

  const registerCustomer = async (): Promise<string> => {
    const email = `stranger-${stamp}@example.com`;
    await server().post('/api/auth/customer/register').send({ email, password: CUSTOMER_PASSWORD });
    return customerLogin(email, CUSTOMER_PASSWORD);
  };

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const waitForStockRow = async (variantId: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRows(variantId)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variantId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const provisionVariant = async (onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E List Refusal ${stamp}`,
        slug: `e2e-list-refusal-${stamp}`,
        description: 'ADR-051 fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-LREF-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variantId = (variantRes.body as { id: number }).id;

    await server()
      .post(`/api/catalog/variants/${variantId}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });

    await settleTimestampRounding();
    await server()
      .post(`/api/catalog/products/${productId}/publish`)
      .set('Authorization', adminAuth);

    await waitForStockRow(variantId);

    await server()
      .post(`/api/inventory/variants/${variantId}/stock/receive`)
      .set('Authorization', adminAuth)
      .send({ quantity: onHand });

    return variantId;
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

    dataSource = new InventoryAutoInitE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);
    ownerToken = await customerLogin(OWNER_EMAIL, CUSTOMER_PASSWORD);
    strangerToken = await registerCustomer();

    const variantId = await provisionVariant(5);

    const cartRes = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ currency: 'USD' });
    const cartId = (cartRes.body as { id: string }).id;

    await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ variantId, quantity: 1 });

    const placeRes = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `list-refusal-${stamp}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(placeRes.status).toBe(HttpStatus.CREATED);
    orderId = (placeRes.body as { id: number }).id;
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('gives a non-owner the SAME refusal on all three lists — 403, never an empty list', async () => {
    const responses = await Promise.all(
      listRoutes(orderId).map((route) =>
        server()
          .get(route)
          .set('Authorization', `Bearer ${strangerToken}`)
          .then((res) => ({ route, status: res.status, body: res.body as unknown })),
      ),
    );

    for (const { route, status, body } of responses) {
      expect({ route, status }).toEqual({ route, status: HttpStatus.FORBIDDEN as number });
      expect(body).not.toEqual([]);
    }

    expect(new Set(responses.map((r) => r.status)).size).toBe(1);
  });

  it('serves the owner on all three lists — empty, because this order has no returns, refunds or fulfillments', async () => {
    for (const route of listRoutes(orderId)) {
      const res = await server().get(route).set('Authorization', `Bearer ${ownerToken}`);

      expect({ route, status: res.status }).toEqual({ route, status: HttpStatus.OK as number });
      expect(res.body).toEqual([]);
    }
  });

  it('serves staff on all three lists', async () => {
    for (const route of listRoutes(orderId)) {
      const res = await server().get(route).set('Authorization', adminAuth);

      expect({ route, status: res.status }).toEqual({ route, status: HttpStatus.OK as number });
      expect(res.body).toEqual([]);
    }
  });

  it('404s on all three lists for an order that does not exist', async () => {
    for (const route of listRoutes(999_999_999)) {
      const res = await server().get(route).set('Authorization', adminAuth);

      expect({ route, status: res.status }).toEqual({
        route,
        status: HttpStatus.NOT_FOUND as number,
      });
    }
  });
});
