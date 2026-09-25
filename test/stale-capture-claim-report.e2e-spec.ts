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

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

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

  it(
    'does NOT report a claim that was opened a moment ago',
    async () => {
      await dataSource.strandCaptureClaim(orderId, FRESH_MINUTES);

      const baseline = await report.execute();

      await dataSource.strandCaptureClaim(orderId, STALE_MINUTES);
      expect(await report.execute()).toBe(baseline + 1);
    },
    timeout,
  );

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
