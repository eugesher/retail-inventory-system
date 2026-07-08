import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { AppModule as InventoryMicroserviceAppModule } from '@retail-inventory-system/apps/inventory-microservice';
import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { ConsentErasureE2ESpecDataSource } from './data-source/consent-erasure.e2e-spec.data-source';

// The tombstone-erase (ADR-037 §2/§3): a customer's PII is nulled IN PLACE while the row's
// id survives, so downstream references (an order's snapshot address, an audit trail) stay
// intact and no foreign key dangles. The customer places a real order first — creating an
// `owner_type='order'` address snapshot — and holds an ACTIVE cart, so the erase has both
// an immutable order snapshot to leave alone and an active cart to abandon.
//
// After the admin erase, the oracle proves:
//   - the `customer` row is PRESERVED with its id + `status='deleted'`, all PII columns
//     (email/phone/first_name/last_name/password_hash) NULL, `deleted_at` set, and
//     `refresh_token_hash` NULL (the session revoked);
//   - the placed order STILL resolves (admin `order:read` staff override) and its
//     `owner_type='order'` address snapshot columns are UNTOUCHED — the erasure writer nulls
//     only `owner_type='customer'` PII, and an order snapshot is immutable (ADR-028);
//   - every active cart the customer held is `abandoned` (and the `converted` order-cart is
//     left alone);
//   - the customer's `consent_record` row is DELETED — the customer opts into marketing
//     first, so the erase has a real opt-in to clear; afterwards the row is gone and an
//     admin consent read falls through to the absent-row defaults (marketing denied), so an
//     erased customer can never be marketed to (ADR-037);
//   - the customer's captured refresh token is rejected (`POST /api/auth/refresh` → `401`).
//
// (No `owner_type='customer'` address is creatable via the API today, so this suite asserts
// the order-snapshot-untouched oracle; the writer's customer-address nulling is unit-covered.)
//
// Asserted through PUBLIC STATE — gateway HTTP + a read-only data-source over the tables an
// erase mutates (no admin "read customer" endpoint exists). The erase itself runs entirely
// gateway-side, so only retail/catalog/inventory (for the real order) are booted alongside
// the gateway. Self-provisioned throwaway customer + fixtures (`e2e-tombstone-*`).
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';

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
  refreshToken: string;
}

interface IRegisteredCustomer {
  id: string;
}

interface ICartBody {
  id: string;
}

interface IOrderBody {
  id: number;
  orderNumber: string;
  status: string;
}

interface IEraseResponse {
  status: string;
  erasedAt: string | null;
}

interface IConsentView {
  transactionalEmail: boolean;
  marketingEmail: boolean;
  marketingSms: boolean;
}

describe('Erase customer — tombstone: PII nulled, order snapshot intact, session revoked (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let retailMicroservice: INestMicroservice;
  let catalogMicroservice: INestMicroservice;
  let inventoryMicroservice: INestMicroservice;
  let dataSource: ConsentErasureE2ESpecDataSource;

  const stamp = Date.now();
  const customerEmail = `e2e-tombstone-${stamp}@example.com`;
  const customerPassword = 'tombstone1234';

  let adminAuth: string;
  let customerAccessToken: string;
  let customerRefreshToken: string;
  let customerId: string;
  let variantId: number;
  let order: IOrderBody;

  const server = (): ReturnType<typeof supertest> => supertest(apiGatewayApp.getHttpServer());

  const bearer = async (email: string, password: string): Promise<string> => {
    const { body } = await server().post('/api/auth/staff/login').send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
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
        name: `E2E Tombstone ${label} ${stamp}`,
        slug: `e2e-tombstone-${label}-${stamp}`,
        description: 'tombstone fixture',
      });
    const productId = (productRes.body as { id: number }).id;

    const variantRes = await server()
      .post(`/api/catalog/products/${productId}/variants`)
      .set('Authorization', adminAuth)
      .send({
        sku: `E2E-TOMBSTONE-${label}-${stamp}`,
        optionValues: { color: 'black', size: 'M' },
      });
    const variant = (variantRes.body as { id: number }).id;

    const priceRes = await server()
      .post(`/api/catalog/variants/${variant}/prices`)
      .set('Authorization', adminAuth)
      .send({ currency: 'USD', amountMinor: 1999 });
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

    dataSource = new ConsentErasureE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
    });
    await dataSource.initialize();

    adminAuth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

    const register = await server()
      .post('/api/auth/customer/register')
      .send({ email: customerEmail, password: customerPassword });
    expect(register.status).toBe(HttpStatus.CREATED);
    customerId = (register.body as IRegisteredCustomer).id;

    const login = await server()
      .post('/api/auth/customer/login')
      .send({ email: customerEmail, password: customerPassword });
    customerAccessToken = (login.body as ITokenResponse).accessToken;
    customerRefreshToken = (login.body as ITokenResponse).refreshToken;

    variantId = await provisionVariant('a', 10);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await retailMicroservice?.close();
    await catalogMicroservice?.close();
    await inventoryMicroservice?.close();
    await dataSource?.destroy();
  });

  it('places a real order for the customer (creating an order-snapshot address)', async () => {
    const create = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerAccessToken}`)
      .send({ currency: 'USD' });
    const cartId = (create.body as ICartBody).id;

    const add = await server()
      .post(`/api/cart/${cartId}/lines`)
      .set('Authorization', `Bearer ${customerAccessToken}`)
      .send({ variantId, quantity: 1 });
    expect(add.status).toBe(HttpStatus.OK);

    const place = await server()
      .post(`/api/cart/${cartId}/place`)
      .set('Authorization', `Bearer ${customerAccessToken}`)
      .set('Idempotency-Key', `tombstone-place-${stamp}`)
      .send({ shippingAddress: ADDRESS, billingAddress: ADDRESS, paymentMethod: 'tok_visa' });
    expect(place.status).toBe(HttpStatus.CREATED);
    order = place.body as IOrderBody;
    expect(order.orderNumber).toBeTruthy();

    // A SECOND, still-active cart so the erase has an active cart to abandon (the order
    // consumed the first cart, flipping it to `converted`).
    const secondCart = await server()
      .post('/api/cart')
      .set('Authorization', `Bearer ${customerAccessToken}`)
      .send({ currency: 'USD' });
    expect(secondCart.status).toBe(HttpStatus.CREATED);
  });

  it('opts the customer into marketing — a consent row the erase must remove', async () => {
    const res = await server()
      .put('/api/auth/customer/me/consent')
      .set('Authorization', `Bearer ${customerAccessToken}`)
      .send({ marketingEmail: true, marketingSms: true });
    expect(res.status).toBe(HttpStatus.OK);

    // Pre-state: the row exists with marketing ON. This is the dangerous state an erase
    // must clear — otherwise it could later be re-loaded and used to send marketing to an
    // erased customer. Asserting it here makes the post-erase oracle non-vacuous.
    const consent = await dataSource.getConsentByCustomerId(customerId);
    expect(consent).toBeDefined();
    expect(consent!.marketingEmail).toBe(true);
    expect(consent!.marketingSms).toBe(true);
  });

  it('erases the customer via the admin endpoint', async () => {
    const res = await server()
      .post(`/api/admin/customers/${customerId}/erase`)
      .set('Authorization', adminAuth)
      .send({ confirmEmail: customerEmail });

    expect(res.status).toBe(HttpStatus.OK);
    const body = res.body as IEraseResponse;
    expect(body.status).toBe('deleted');
    expect(body.erasedAt).toBeTruthy();
  });

  it('preserves the customer row with its id but nulls all PII + revokes the session', async () => {
    const row = await dataSource.getCustomerById(customerId);

    expect(row).toBeDefined();
    expect(row!.id).toBe(customerId);
    expect(row!.status).toBe('deleted');
    expect(row!.email).toBeNull();
    expect(row!.phone).toBeNull();
    expect(row!.firstName).toBeNull();
    expect(row!.lastName).toBeNull();
    expect(row!.passwordHash).toBeNull();
    expect(row!.refreshTokenHash).toBeNull();
    expect(row!.deletedAt).not.toBeNull();
  });

  it('deletes the consent record so an erased customer can no longer be marketed to', async () => {
    // Row-level: the `consent_record` row is GONE. The erase deletes it in the same
    // transaction — the tombstone never hard-deletes the customer, so the FK CASCADE never
    // fires; the row must be removed explicitly (ADR-037).
    const consent = await dataSource.getConsentByCustomerId(customerId);
    expect(consent).toBeUndefined();

    // Behavior: an admin consent read now resolves to the absent-row DEFAULTS
    // (transactional on, marketing OFF) — even though the customer had opted INTO marketing
    // before the erase — so the notification consent-gate suppresses any marketing dispatch.
    const readRes = await server()
      .get(`/api/admin/customers/${customerId}/consent`)
      .set('Authorization', adminAuth);
    expect(readRes.status).toBe(HttpStatus.OK);
    const view = readRes.body as IConsentView;
    expect(view.transactionalEmail).toBe(true);
    expect(view.marketingEmail).toBe(false);
    expect(view.marketingSms).toBe(false);
  });

  it('leaves the placed order resolvable with its order-snapshot address intact', async () => {
    // The order still resolves under an admin `order:read` staff override.
    const orderRes = await server().get(`/api/orders/${order.id}`).set('Authorization', adminAuth);
    expect(orderRes.status).toBe(HttpStatus.OK);
    expect((orderRes.body as IOrderBody).id).toBe(order.id);

    // The `owner_type='order'` snapshot addresses (billing + shipping) are untouched.
    const addresses = await dataSource.getAddressesByOwner('order', String(order.id));
    expect(addresses.length).toBeGreaterThanOrEqual(1);
    for (const address of addresses) {
      expect(address.recipientName).toBe(ADDRESS.recipientName);
      expect(address.line1).toBe(ADDRESS.line1);
      expect(address.city).toBe(ADDRESS.city);
      expect(address.postalCode).toBe(ADDRESS.postalCode);
    }
  });

  it('abandons every active cart the customer held', async () => {
    const carts = await dataSource.getCartsByCustomerId(customerId);

    expect(carts.length).toBeGreaterThanOrEqual(2);
    // No cart is left active — the erase abandoned the live one.
    expect(carts.every((cart) => cart.status !== 'active')).toBe(true);
    // The second cart, active at erase time, is now abandoned.
    expect(carts.some((cart) => cart.status === 'abandoned')).toBe(true);
    // The order-cart stays `converted` (the erase does not touch a non-active cart).
    expect(carts.some((cart) => cart.status === 'converted')).toBe(true);
  });

  it('rejects the erased customer’s captured refresh token', async () => {
    const res = await server()
      .post('/api/auth/refresh')
      .send({ refreshToken: customerRefreshToken });

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
  });
});
