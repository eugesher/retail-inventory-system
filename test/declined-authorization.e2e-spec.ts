import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import {
  MicroserviceQueueEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';

import { PAYMENT_GATEWAY } from '../apps/retail-microservice/src/modules/orders/application/ports';
import type { IPaymentGatewayPort } from '../apps/retail-microservice/src/modules/orders/application/ports';
import { CaptureClaimE2ESpecDataSource } from './data-source/capture-claim.e2e-spec.data-source';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const RECEIVED = 20;

const ADDRESS = {
  recipientName: 'Declined Card',
  line1: '1 Market St',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94105',
  country: 'US',
};

interface ITokenResponse {
  accessToken: string;
}

describe('A declined authorization leaves no orphan (e2e)', () => {
  const timeout = 120_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: CaptureClaimE2ESpecDataSource;

  let gateway: IPaymentGatewayPort;
  let authorizeSpy: jest.SpyInstance;

  const stamp = Date.now();
  let adminAuth: string;
  let customerToken: string;
  let variantId: number;

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

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const waitForStockRow = async (variant: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelCount(variant)) === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for the auto-init stock_level row for ${variant}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const availableNow = async (): Promise<number> => {
    const { body } = await server().get(`/api/inventory/variants/${variantId}/stock`);
    return (body as { totalAvailable: number }).totalAvailable;
  };

  const provisionVariant = async (onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Declined ${stamp}`,
        slug: `e2e-declined-${stamp}`,
        description: 'ISSUE-06 fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({ sku: `E2E-DECL-${stamp}`, optionValues: { color: 'black', size: 'M' } });
    const variant = (variantRes.body as { id: number }).id;

    await server()
      .post(`/api/catalog/variants/${variant}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });

    await settleTimestampRounding();
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

  const openCart = async (quantity: number): Promise<string> => {
    const cartRes = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    const cartId = (cartRes.body as { id: string }).id;

    await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity });

    return cartId;
  };

  const place = (cartId: string, idempotencyKey: string): supertest.Test =>
    server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });

  const declineOnce = (): void => {
    authorizeSpy.mockImplementationOnce(() =>
      Promise.resolve({
        approved: false,
        gatewayReference: `fake_declined_${stamp}`,
        method: 'fake-card',
        authorizedAt: new Date(),
      }),
    );
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

    gateway = retailMicroservice.get<IPaymentGatewayPort>(PAYMENT_GATEWAY, { strict: false });
    authorizeSpy = jest.spyOn(gateway, 'authorize');

    dataSource = new CaptureClaimE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);
    customerToken = await customerLogin();
    variantId = await provisionVariant(RECEIVED);
  }, timeout);

  afterAll(async () => {
    authorizeSpy?.mockRestore();
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it(
    'surfaces the decline, RELEASES the stock, and leaves the order dead on both axes',
    async () => {
      const before = await availableNow();
      const cartId = await openCart(3);
      declineOnce();

      const res = await place(cartId, `decl-${stamp}`);

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect((res.body as { code: string }).code).toBe('ORDER_PAYMENT_NOT_APPROVED');

      expect(await availableNow()).toBe(before);

      const orders = await dataSource.query(
        `SELECT status, payment_status FROM \`order\` WHERE source_cart_id = ?;`,
        [cartId],
      );
      expect(orders).toHaveLength(1);
      expect(orders[0].status).toBe(OrderStatusEnum.CANCELLED);
      expect(orders[0].payment_status).toBe(OrderPaymentStatusEnum.FAILED);

      expect(await dataSource.getPayment(orders[0].id)).toBeUndefined();
    },
    timeout,
  );

  it(
    'REFUSES a retry under a fresh Idempotency-Key — the customer is not told their declined order went through',
    async () => {
      const cartId = await openCart(2);
      declineOnce();

      const first = await place(cartId, `decl-retry-a-${stamp}`);
      expect(first.status).toBe(HttpStatus.CONFLICT);

      const retry = await place(cartId, `decl-retry-b-${stamp}`);

      expect(retry.status).toBe(HttpStatus.CONFLICT);
      expect((retry.body as { code: string }).code).toBe('ORDER_PAYMENT_NOT_APPROVED');
    },
    timeout,
  );

  it(
    'the happy path is unchanged — a successful place still converts, allocates and authorizes',
    async () => {
      const before = await availableNow();
      const cartId = await openCart(1);

      const res = await place(cartId, `decl-happy-${stamp}`);

      expect(res.status).toBe(HttpStatus.CREATED);
      const view = res.body as {
        id: number;
        status: string;
        paymentStatus: string;
        payment: { id: number } | undefined;
      };
      expect(view.status).toBe(OrderStatusEnum.PENDING);
      expect(view.paymentStatus).toBe(OrderPaymentStatusEnum.AUTHORIZED);
      expect(view.payment).toBeDefined();

      expect(await availableNow()).toBe(before - 1);
    },
    timeout,
  );
});
