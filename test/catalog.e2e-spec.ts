import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

// Seeded staff users (scripts/test-db-seed.ts). `admin` carries every
// permission (incl. `catalog:write` / `catalog:publish`); `warehouse` carries
// only `inventory:*` — no catalog codes — so it is the negative fixture for the
// write/publish gates.
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const WAREHOUSE_EMAIL = 'warehouse@example.com';
const WAREHOUSE_PASSWORD = 'warehouse1234';

interface ITokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface IProductBody {
  id: number;
  name: string;
  slug: string;
  description: string;
  status: string;
  publishedAt?: string;
  archivedAt?: string;
}

interface IVariantBody {
  id: number;
  productId: number;
  sku: string;
  status: string;
}

interface IProductWithVariantsBody extends IProductBody {
  variants: IVariantBody[];
}

interface IVariantWithProductBody extends IVariantBody {
  product: IProductBody;
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

describe('Catalog gateway endpoints (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let catalogMicroservice: INestMicroservice;

  // Stamped so the flow stays idempotent under `yarn test:e2e:run` against an
  // already-seeded DB: a fresh slug/sku set every run, and `search=<stamp>`
  // isolates this run's product in the shared browse list.
  const stamp = Date.now();
  const productName = `E2E Aeron Chair ${stamp}`;
  const productSlug = `e2e-aeron-chair-${stamp}`;
  const skuA = `E2E-AERON-BLK-M-${stamp}`;
  const skuB = `E2E-AERON-RED-L-${stamp}`;

  let productId: number;
  const variantIds: number[] = [];

  const login = async (email: string, password: string): Promise<ITokenResponse> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password });
    return body as ITokenResponse;
  };

  const bearer = async (email: string, password: string): Promise<string> => {
    const tokens = await login(email, password);
    return `Bearer ${tokens.accessToken}`;
  };

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

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
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await catalogMicroservice?.close();
  });

  describe('register → add variants → publish → browse → archive → browse', () => {
    it('admin registers a draft product', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/products')
        .set('Authorization', auth)
        .send({ name: productName, slug: productSlug, description: 'E2E fixture chair' });

      expect(status).toBe(HttpStatus.CREATED);
      const product = body as IProductBody;
      expect(product.status).toBe('draft');
      expect(product.slug).toBe(productSlug);
      expect(typeof product.id).toBe('number');
      productId = product.id;
    });

    it('admin appends two variants with distinct SKUs', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const variants: { sku: string; optionValues: Record<string, string> }[] = [
        { sku: skuA, optionValues: { color: 'black', size: 'M' } },
        { sku: skuB, optionValues: { color: 'red', size: 'L' } },
      ];

      for (const variant of variants) {
        const { status, body } = await supertest(apiGatewayApp.getHttpServer())
          .post(`/api/catalog/products/${productId}/variants`)
          .set('Authorization', auth)
          .send(variant);

        expect(status).toBe(HttpStatus.CREATED);
        const created = body as IVariantBody;
        expect(created.sku).toBe(variant.sku);
        expect(created.productId).toBe(productId);
        expect(created.status).toBe('active');
        variantIds.push(created.id);
      }

      expect(variantIds).toHaveLength(2);
    });

    it('admin publishes the product (draft → active)', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/catalog/products/${productId}/publish`)
        .set('Authorization', auth);

      expect(status).toBe(HttpStatus.OK);
      const product = body as IProductBody;
      expect(product.status).toBe('active');
      expect(product.publishedAt).toBeDefined();
    });

    it('anonymous browse lists the published product with both variants', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/catalog/products')
        .query({ search: String(stamp) });

      expect(status).toBe(HttpStatus.OK);
      const page = body as IPageBody<IProductWithVariantsBody>;
      const item = page.items.find((p) => p.slug === productSlug);
      expect(item).toBeDefined();
      expect(item?.status).toBe('active');
      expect((item?.variants ?? []).map((v) => v.sku).sort()).toEqual([skuA, skuB].sort());
    });

    it('anonymous get-by-slug resolves the product with its active variants', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(
        `/api/catalog/products/${productSlug}`,
      );

      expect(status).toBe(HttpStatus.OK);
      const product = body as IProductWithVariantsBody;
      expect(product.id).toBe(productId);
      expect(product.variants).toHaveLength(2);
    });

    it('anonymous get-variant resolves a variant with its parent product header', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(
        `/api/catalog/variants/${variantIds[0]}`,
      );

      expect(status).toBe(HttpStatus.OK);
      const variant = body as IVariantWithProductBody;
      expect(variant.id).toBe(variantIds[0]);
      expect(variant.product.id).toBe(productId);
    });

    it('admin archives the product (active → archived)', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/catalog/products/${productId}/archive`)
        .set('Authorization', auth);

      expect(status).toBe(HttpStatus.OK);
      const product = body as IProductBody;
      expect(product.status).toBe('archived');
      expect(product.archivedAt).toBeDefined();
    });

    it('the archived product drops out of the default active browse', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .get('/api/catalog/products')
        .query({ search: String(stamp) });

      expect(status).toBe(HttpStatus.OK);
      const page = body as IPageBody<IProductWithVariantsBody>;
      expect(page.items.find((p) => p.slug === productSlug)).toBeUndefined();
    });
  });

  describe('authorization gates', () => {
    it('a staff user without catalog permissions gets 403 on register', async () => {
      const auth = await bearer(WAREHOUSE_EMAIL, WAREHOUSE_PASSWORD);

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/products')
        .set('Authorization', auth)
        .send({ name: `Forbidden ${stamp}`, slug: `forbidden-${stamp}` });

      expect(status).toBe(HttpStatus.FORBIDDEN);
    });

    it('a staff user without catalog permissions gets 403 on publish', async () => {
      const auth = await bearer(WAREHOUSE_EMAIL, WAREHOUSE_PASSWORD);

      // The permission gate fires in `PermissionsGuard`, before the route's
      // `ParseIntPipe` or any RPC — so a fixed id is enough to assert the 403.
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/products/1/publish')
        .set('Authorization', auth);

      expect(status).toBe(HttpStatus.FORBIDDEN);
    });

    it('an unauthenticated write request gets 401', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/products')
        .send({ name: `Anon ${stamp}`, slug: `anon-${stamp}` });

      expect(status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('an unauthenticated request gets 200 on the public browse', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer()).get(
        '/api/catalog/products',
      );

      expect(status).toBe(HttpStatus.OK);
    });
  });

  // The catalog microservice maps each typed CatalogDomainException onto an HTTP
  // status via CatalogRpcExceptionFilter; the gateway's throwRpcError resolves it
  // (ADR-025). These reuse the fixtures the happy-path flow left behind:
  // `productSlug`/`skuA` are taken and `productId` is archived (a non-draft).
  describe('typed domain errors map to HTTP statuses', () => {
    it('get-by-slug for an unknown product returns 404 (not 500)', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer()).get(
        `/api/catalog/products/no-such-slug-${stamp}`,
      );

      expect(status).toBe(HttpStatus.NOT_FOUND);
    });

    it('get-variant for an unknown id returns 404 (not 500)', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer()).get(
        '/api/catalog/variants/999999999',
      );

      expect(status).toBe(HttpStatus.NOT_FOUND);
    });

    it('registering a product with a taken slug returns 409', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/products')
        .set('Authorization', auth)
        .send({ name: `Dup ${stamp}`, slug: productSlug });

      expect(status).toBe(HttpStatus.CONFLICT);
    });

    it('adding a variant with a taken sku returns 409', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/catalog/products/${productId}/variants`)
        .set('Authorization', auth)
        .send({ sku: skuA, optionValues: { color: 'black', size: 'M' } });

      expect(status).toBe(HttpStatus.CONFLICT);
    });

    it('publishing a non-draft (archived) product returns 409', async () => {
      const auth = await bearer(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/catalog/products/${productId}/publish`)
        .set('Authorization', auth);

      expect(status).toBe(HttpStatus.CONFLICT);
    });
  });
});
