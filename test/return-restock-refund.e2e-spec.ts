import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { ReturnsRefundsE2ESpecDataSource } from './data-source/returns-refunds.e2e-spec.data-source';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';
const DEFAULT_WAREHOUSE = 'default-warehouse';

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

interface IStockLevelBody {
  stockLocationId: string;
  quantityOnHand: number;
  quantityAllocated: number;
  quantityReserved: number;
  available: number;
}

interface IVariantStockBody {
  variantId: number;
  totalOnHand: number;
  totalAvailable: number;
  locations: IStockLevelBody[];
}

interface ICartBody {
  id: string;
}

interface IPaymentBody {
  id: number;
  status: string;
}

interface IOrderLineBody {
  id: number;
  variantId: number;
  quantity: number;
  status: string;
}

interface IOrderBody {
  id: number;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  lines: IOrderLineBody[];
  payment?: IPaymentBody;
}

interface IFulfillmentBody {
  id: number;
  status: string;
}

interface IReturnLineBody {
  id: number;
  orderLineId: number;
  quantity: number;
  condition: string | null;
  disposition: string | null;
  lineRefundAmountMinor: number | null;
}

interface IReturnBody {
  id: number;
  rmaNumber: string | null;
  orderId: number;
  status: string;
  closedAt: string | null;
  lines: IReturnLineBody[];
}

interface IRefundBody {
  id: number;
  orderId: number;
  paymentId: number;
  amountMinor: number;
  status: string;
  gatewayReference: string | null;
}

interface IMovementBody {
  id: number;
  type: string;
  quantity: number;
  referenceType: string | null;
  referenceId: string | null;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Returns + refunds: place → ship → deliver → return → restock → refund (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: ReturnsRefundsE2ESpecDataSource;

  const stamp = Date.now();
  let adminAuth: string;
  let customerToken: string;

  let variantId: number;
  let cartId: string;
  let order: IOrderBody;
  let orderLineId: number;
  let paymentId: number;
  let fulfillmentId: number;
  let rmaId: number;
  let returnLineId: number;
  let onHandBeforeRestock: number;

  const ORDERED_QTY = 2;
  const RETURNED_QTY = 1;
  const RECEIVED_QTY = 5;
  const UNIT_PRICE_MINOR = 1999;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const customerLogin = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/customer/login').send({ email, password });
    return (body as ITokenResponse).accessToken;
  };

  const settleTimestampRounding = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1_500));

  const waitForStockRow = async (variant: number, deadlineMs = 20_000): Promise<void> => {
    const start = Date.now();
    while ((await dataSource.getStockLevelRows(variant)).length === 0) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`Timed out waiting for auto-init stock_level row for variant ${variant}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const provisionVariant = async (label: string, onHand: number): Promise<number> => {
    const productRes = await server()
      .post('/api/catalog/products')
      .set('Authorization', adminAuth)
      .send({
        name: `E2E Return Restock ${label} ${stamp}`,
        slug: `e2e-return-restock-${label}-${stamp}`,
        description: 'return-restock-refund fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({
        sku: `E2E-RETRESTOCK-${label}-${stamp}`,
        optionValues: { color: 'black', size: 'M' },
      });
    const variant = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variant}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: UNIT_PRICE_MINOR });
    expect(priceRes.status).toBe(HttpStatus.CREATED);

    await settleTimestampRounding();

    const publishRes = await server()
      .post(`/api/catalog/products/${productId}/publish`)
      .set('Authorization', adminAuth);
    expect(publishRes.status).toBe(HttpStatus.OK);

    await waitForStockRow(variant);

    const receiveRes = await server()
      .post(`/api/inventory/variants/${variant}/stock/receive`)
      .set('Authorization', adminAuth)
      .send({ quantity: onHand });
    expect(receiveRes.status).toBe(HttpStatus.OK);

    return variant;
  };

  const warehouseLevel = async (variant: number): Promise<IStockLevelBody> => {
    const { body } = await server().get(`/api/inventory/variants/${variant}/stock`);
    const stock = body as IVariantStockBody;
    return (
      stock.locations.find((l) => l.stockLocationId === DEFAULT_WAREHOUSE) ?? {
        stockLocationId: DEFAULT_WAREHOUSE,
        quantityOnHand: 0,
        quantityAllocated: 0,
        quantityReserved: 0,
        available: 0,
      }
    );
  };

  const listReturnMovements = async (variant: number): Promise<IMovementBody[]> => {
    const { body } = await server()
      .get(`/api/inventory/variants/${variant}/movements`)
      .query({ type: 'return' })
      .set('Authorization', adminAuth);
    return (body as IPageBody<IMovementBody>).items;
  };

  const getOrder = async (orderId: number): Promise<IOrderBody> => {
    const { body } = await server().get(`/api/orders/${orderId}`).set('Authorization', adminAuth);
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

    dataSource = new ReturnsRefundsE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);
    customerToken = await customerLogin(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

    variantId = await provisionVariant('a', RECEIVED_QTY);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('places a two-unit order, then ships + delivers it (so it is returnable)', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ currency: 'USD' });
    cartId = (create.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ variantId, quantity: ORDERED_QTY });
    expect(add.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', `return-restock-${stamp}-place`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);

    order = place.body as IOrderBody;
    expect(order.paymentStatus).toBe('authorized');
    orderLineId = order.lines[0].id;

    const createFul = await server()
      .post(`/api/orders/${order.id}/fulfillments`)
      .set('Authorization', adminAuth)
      .send({
        stockLocationId: DEFAULT_WAREHOUSE,
        lines: [{ orderLineId, quantity: ORDERED_QTY }],
      });
    expect(createFul.status).toBe(HttpStatus.CREATED);
    fulfillmentId = (createFul.body as IFulfillmentBody).id;

    const ship = await server()
      .post(`/api/orders/${order.id}/fulfillments/${fulfillmentId}/ship`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `return-restock-${stamp}-ship`)
      .send({ trackingNumber: '1Z999AA10123456784', carrier: 'UPS' });
    expect(ship.status).toBe(HttpStatus.OK);

    const deliver = await server()
      .post(`/api/orders/${order.id}/fulfillments/${fulfillmentId}/deliver`)
      .set('Authorization', adminAuth);
    expect(deliver.status).toBe(HttpStatus.OK);

    const fresh = await getOrder(order.id);
    expect(fresh.status).toBe('delivered');
    expect(fresh.fulfillmentStatus).toBe('delivered');
    expect(fresh.paymentStatus).toBe('captured');
    expect(fresh.payment?.status).toBe('captured');
    paymentId = fresh.payment!.id;

    onHandBeforeRestock = (await warehouseLevel(variantId)).quantityOnHand;
    expect(onHandBeforeRestock).toBe(RECEIVED_QTY - ORDERED_QTY);

    expect(await listReturnMovements(variantId)).toHaveLength(0);
  });

  it('the owning customer opens an RMA for one of the two units → requested', async () => {
    const open = await server()
      .post(`/api/orders/${order.id}/returns`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        reasonCategory: 'defective',
        notes: 'One unit arrived with a cracked screen',
        lines: [{ orderLineId, quantity: RETURNED_QTY }],
      });
    expect(open.status).toBe(HttpStatus.CREATED);

    const rma = open.body as IReturnBody;
    expect(rma.status).toBe('requested');
    expect(rma.orderId).toBe(order.id);
    expect(rma.rmaNumber).toMatch(/^RMA-\d{4}-\d{8}$/);
    expect(rma.lines).toHaveLength(1);
    expect(rma.lines[0].orderLineId).toBe(orderLineId);
    expect(rma.lines[0].quantity).toBe(RETURNED_QTY);
    expect(rma.lines[0].condition).toBeNull();
    expect(rma.lines[0].disposition).toBeNull();
    expect(rma.lines[0].lineRefundAmountMinor).toBeNull();

    rmaId = rma.id;
    returnLineId = rma.lines[0].id;
  });

  it('staff authorizes → receives the RMA (no stock moves yet)', async () => {
    const authorize = await server()
      .post(`/api/returns/${rmaId}/authorize`)
      .set('Authorization', adminAuth);
    expect(authorize.status).toBe(HttpStatus.OK);
    expect((authorize.body as IReturnBody).status).toBe('authorized');

    const receive = await server()
      .post(`/api/returns/${rmaId}/receive`)
      .set('Authorization', adminAuth);
    expect(receive.status).toBe(HttpStatus.OK);
    expect((receive.body as IReturnBody).status).toBe('received');

    expect((await warehouseLevel(variantId)).quantityOnHand).toBe(onHandBeforeRestock);
    expect(await listReturnMovements(variantId)).toHaveLength(0);
  });

  it('inspects with a `restock` disposition → on-hand rises by the restocked qty + one `return` movement', async () => {
    const inspect = await server()
      .post(`/api/returns/${rmaId}/inspect`)
      .set('Authorization', adminAuth)
      .send({
        lines: [
          {
            returnLineId,
            condition: 'new',
            disposition: 'restock',
            lineRefundAmountMinor: UNIT_PRICE_MINOR,
          },
        ],
      });
    expect(inspect.status).toBe(HttpStatus.OK);

    const inspected = inspect.body as IReturnBody;
    expect(inspected.status).toBe('inspected');
    expect(inspected.lines[0].condition).toBe('new');
    expect(inspected.lines[0].disposition).toBe('restock');
    expect(inspected.lines[0].lineRefundAmountMinor).toBe(UNIT_PRICE_MINOR);

    const level = await warehouseLevel(variantId);
    expect(level.quantityOnHand).toBe(onHandBeforeRestock + RETURNED_QTY);
    expect(level.quantityAllocated).toBe(0);
    expect(level.quantityReserved).toBe(0);

    const movements = await listReturnMovements(variantId);
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe('return');
    expect(movements[0].quantity).toBe(RETURNED_QTY);
    expect(movements[0].referenceType).toBe('return-request');
    expect(movements[0].referenceId).toBe(String(rmaId));
  });

  it('closes the RMA → closed (terminal); closing issues no refund on its own', async () => {
    const close = await server()
      .post(`/api/returns/${rmaId}/close`)
      .set('Authorization', adminAuth);
    expect(close.status).toBe(HttpStatus.OK);

    const closed = close.body as IReturnBody;
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();

    expect(await dataSource.getRefundsByOrderId(order.id)).toHaveLength(0);
    const payment = await dataSource.getPaymentByOrderId(order.id);
    expect(payment?.refundedAmountMinor).toBe(0);
  });

  it('issues a refund for the returned unit → Refund.status=issued, refunded_amount_minor reflects', async () => {
    const refund = await server()
      .post(`/api/orders/${order.id}/refunds`)
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', `return-restock-${stamp}-refund`)
      .send({ paymentId, amountMinor: UNIT_PRICE_MINOR, reason: 'Returned unit refund' });
    expect(refund.status).toBe(HttpStatus.CREATED);

    const issued = refund.body as IRefundBody;
    expect(issued.status).toBe('issued');
    expect(issued.orderId).toBe(order.id);
    expect(issued.paymentId).toBe(paymentId);
    expect(issued.amountMinor).toBe(UNIT_PRICE_MINOR);
    expect(issued.gatewayReference).not.toBeNull();

    const payment = await dataSource.getPaymentByOrderId(order.id);
    expect(payment?.refundedAmountMinor).toBe(UNIT_PRICE_MINOR);
    expect(payment?.status).toBe('captured');

    const fresh = await getOrder(order.id);
    expect(fresh.payment?.status).toBe('captured');

    const list = await server()
      .get(`/api/orders/${order.id}/refunds`)
      .set('Authorization', adminAuth);
    expect(list.status).toBe(HttpStatus.OK);
    const refunds = list.body as IRefundBody[];
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe('issued');
    expect(refunds[0].amountMinor).toBe(UNIT_PRICE_MINOR);
  });
});
