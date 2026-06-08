import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import {
  MicroserviceQueueEnum,
  OrderProductStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';
import { CORRELATION_ID_HEADER } from '@retail-inventory-system/observability';
import { SystemApiE2ESpecDataSource } from './data-source';

// The inventory microservice now exposes only the `inventory.order.confirm`
// deprecation stub (stock reservation moved to the inventory-reservation
// capability), so this suite covers order creation/validation through the
// gateway. It still boots the inventory microservice to prove the trimmed
// service comes up clean.
describe('Retail Inventory System API', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: SystemApiE2ESpecDataSource;
  let staffAccessToken: string;

  // `admin@example.com` is established by `yarn test:seed`; one login, reused
  // across every assertion below as a bearer-token source. The order endpoints
  // here carry no customer association — future checkout work re-links orders
  // to the gateway customer aggregate.
  const httpClient = () => {
    const agent = supertest.agent(apiGatewayApp.getHttpServer());
    agent.set('Authorization', `Bearer ${staffAccessToken}`);
    return agent;
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

    await Promise.all([retailMicroservice.listen(), inventoryMicroservice.listen()]);

    apiGatewayApp = await NestFactory.create(ApiGatewayAppModule, { logger: false });
    apiGatewayApp.setGlobalPrefix('api');
    apiGatewayApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );

    await apiGatewayApp.init();

    dataSource = new SystemApiE2ESpecDataSource({ type: 'mysql', url: process.env.DATABASE_URL! });

    await dataSource.initialize();

    const loginResponse = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'admin1234' });
    staffAccessToken = loginResponse.body.accessToken;
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  describe('Order', () => {
    describe('POST /api/order', () => {
      const apiHref = '/api/order';

      const getDataToBeAsserted = async (orderId: number) => {
        const [orderRows, orderProductRows] = await Promise.all([
          dataSource.getOrderRowsByOrderId(orderId),
          dataSource.getOrderProductRowsByOrderId(orderId),
        ]);

        return { orderRows, orderProductRows };
      };

      const assertData = (data: { body: any; orderRows: any[]; orderProductRows: any[] }) => {
        const { body, orderRows, orderProductRows } = data;

        expect(body).toMatchSnapshot('0_RESPONSE_BODY');
        expect(orderRows).toMatchSnapshot('1_ORDERS');
        expect(orderProductRows).toMatchSnapshot('2_ORDER_PRODUCTS');
      };

      it('creates an order with a single product', async () => {
        const { status, body, headers } = await httpClient()
          .post(apiHref)
          .send({ products: [{ productId: 1, quantity: 1 }] });

        const { orderRows, orderProductRows } = await getDataToBeAsserted(body.orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.CREATED);
        // TEST-001: explicit field assertions to attribute regressions —
        // status string, header row count, line-item expansion count.
        expect(body.orderId).toEqual(expect.any(Number));
        expect(body.status).toBe(OrderStatusEnum.PENDING);
        expect(orderRows).toHaveLength(1);
        expect(orderRows[0].status_id).toBe(OrderStatusEnum.PENDING);
        expect(orderProductRows).toHaveLength(1);
        expect(
          orderProductRows.every((r: any) => r.status_id === OrderProductStatusEnum.PENDING),
        ).toBe(true);
        assertData({ body, orderRows, orderProductRows });
      });

      it('creates an order expanding each product quantity into individual order_product rows', async () => {
        const { status, body, headers } = await httpClient()
          .post(apiHref)
          .send({
            products: [
              { productId: 1, quantity: 2 },
              { productId: 2, quantity: 1 },
            ],
          });

        const { orderRows, orderProductRows } = await getDataToBeAsserted(body.orderId);

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.CREATED);
        expect(body.status).toBe(OrderStatusEnum.PENDING);
        expect(orderRows).toHaveLength(1);
        expect(orderProductRows).toHaveLength(3);
        expect(
          orderProductRows.every((r: any) => r.status_id === OrderProductStatusEnum.PENDING),
        ).toBe(true);
        assertData({ body, orderRows, orderProductRows });
      });

      it('returns 400 when products array is empty', async () => {
        const { status, body, headers } = await httpClient().post(apiHref).send({ products: [] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when products is missing', async () => {
        const { status, body, headers } = await httpClient().post(apiHref).send({});

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when products[].productId is not a positive integer', async () => {
        const { status, body, headers } = await httpClient()
          .post(apiHref)
          .send({ products: [{ productId: 0, quantity: 1 }] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when products[].quantity is not a positive integer', async () => {
        const { status, body, headers } = await httpClient()
          .post(apiHref)
          .send({ products: [{ productId: 1, quantity: 0 }] });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });

      it('returns 400 when the request body contains an unknown field', async () => {
        const { status, body, headers } = await httpClient()
          .post(apiHref)
          .send({ products: [{ productId: 1, quantity: 1 }], unknownField: 'x' });

        expect(headers[CORRELATION_ID_HEADER]).toBeDefined();
        expect(status).toBe(HttpStatus.BAD_REQUEST);
        expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(body.error).toBe('Bad Request');
        expect(body).toMatchSnapshot();
      });
    });
  });
});
