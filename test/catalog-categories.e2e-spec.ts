import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

const SEEDED_PRODUCT_ID = 1;

interface ITokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface ICategoryBody {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
  path: string;
  sortOrder: number;
  status: string;
}

interface ICategoryTreeBody extends ICategoryBody {
  children: ICategoryTreeBody[];
}

interface IReparentBody {
  category: ICategoryBody;
  rewrittenDescendantCount: number;
}

interface IProductCategoriesBody {
  product: { id: number; slug: string };
  categories: ICategoryBody[];
}

interface IProductWithVariantsBody {
  id: number;
  slug: string;
  status: string;
  variants: { id: number; sku: string }[];
}

interface IPageBody<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

interface IErrorBody {
  statusCode: number;
  message: string | string[];
  code?: string;
}

describe('Catalog category gateway endpoints (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let catalogMicroservice: INestMicroservice;

  const stamp = Date.now();
  const menswear = `menswear-${stamp}`;
  const shirts = `shirts-${stamp}`;
  const trousers = `trousers-${stamp}`;
  const oxford = `oxford-${stamp}`;
  const clearance = `clearance-${stamp}`;
  const ownSlugs = new Set([menswear, shirts, trousers, oxford, clearance]);

  let menswearId: number;
  let shirtsId: number;

  const login = async (email: string, password: string): Promise<string> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/staff/login')
      .send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const loginCustomer = async (): Promise<string> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const createCategory = async (
    auth: string,
    payload: { name: string; slug: string; parentSlug?: string; sortOrder?: number },
  ): Promise<ICategoryBody> => {
    const { status, body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/catalog/categories')
      .set('Authorization', auth)
      .send(payload);
    expect(status).toBe(HttpStatus.CREATED);
    return body as ICategoryBody;
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

  describe('hierarchy creation + materialized paths', () => {
    it('admin creates a root + two children + a grandchild with correct paths', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const root = await createCategory(auth, { name: 'Menswear', slug: menswear });
      expect(root.path).toBe(`/${menswear}`);
      expect(root.parentId).toBeNull();
      expect(root.status).toBe('active');
      menswearId = root.id;

      const shirtsCat = await createCategory(auth, {
        name: 'Shirts',
        slug: shirts,
        parentSlug: menswear,
      });
      expect(shirtsCat.path).toBe(`/${menswear}/${shirts}`);
      expect(shirtsCat.parentId).toBe(menswearId);
      shirtsId = shirtsCat.id;

      const trousersCat = await createCategory(auth, {
        name: 'Trousers',
        slug: trousers,
        parentSlug: menswear,
      });
      expect(trousersCat.path).toBe(`/${menswear}/${trousers}`);
      expect(trousersCat.parentId).toBe(menswearId);

      const oxfordCat = await createCategory(auth, {
        name: 'Oxford',
        slug: oxford,
        parentSlug: shirts,
      });
      expect(oxfordCat.path).toBe(`/${menswear}/${shirts}/${oxford}`);
      expect(oxfordCat.parentId).toBe(shirtsId);
    });

    it('?root=true lists the root but not the children', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(
        '/api/catalog/categories?root=true',
      );

      expect(status).toBe(HttpStatus.OK);
      const slugs = (body as ICategoryBody[]).map((c) => c.slug);
      expect(slugs).toContain(menswear);
      expect(slugs).not.toContain(shirts);
    });

    it('the full flat list contains all four created categories', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(
        '/api/catalog/categories',
      );

      expect(status).toBe(HttpStatus.OK);
      const slugs = (body as ICategoryBody[]).map((c) => c.slug);
      for (const slug of [menswear, shirts, trousers, oxford]) {
        expect(slugs).toContain(slug);
      }
    });

    it('the tree nests shirts → oxford and trousers under the root', async () => {
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(
        `/api/catalog/categories/${menswear}/tree`,
      );

      expect(status).toBe(HttpStatus.OK);
      const tree = body as ICategoryTreeBody;
      expect(tree.slug).toBe(menswear);

      const childSlugs = tree.children.map((c) => c.slug).sort();
      expect(childSlugs).toEqual([shirts, trousers].sort());

      const shirtsNode = tree.children.find((c) => c.slug === shirts)!;
      expect(shirtsNode.children.map((c) => c.slug)).toEqual([oxford]);

      const trousersNode = tree.children.find((c) => c.slug === trousers)!;
      expect(trousersNode.children).toEqual([]);
    });
  });

  describe('reparent + subtree rebase', () => {
    it('reparenting shirts under a new root rebases its descendant in the same transaction', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const clearanceCat = await createCategory(auth, { name: 'Clearance', slug: clearance });
      expect(clearanceCat.path).toBe(`/${clearance}`);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch(`/api/catalog/categories/${shirts}/parent`)
        .set('Authorization', auth)
        .send({ newParentSlug: clearance });

      expect(status).toBe(HttpStatus.OK);
      const reparented = body as IReparentBody;
      expect(reparented.category.path).toBe(`/${clearance}/${shirts}`);
      expect(reparented.rewrittenDescendantCount).toBe(1);

      const tree = await supertest(apiGatewayApp.getHttpServer()).get(
        `/api/catalog/categories/${shirts}/tree`,
      );
      const oxfordNode = (tree.body as ICategoryTreeBody).children.find((c) => c.slug === oxford)!;
      expect(oxfordNode.path).toBe(`/${clearance}/${shirts}/${oxford}`);
    });

    it('reparenting shirts with no new parent demotes it to a root', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch(`/api/catalog/categories/${shirts}/parent`)
        .set('Authorization', auth)
        .send({});

      expect(status).toBe(HttpStatus.OK);
      const reparented = body as IReparentBody;
      expect(reparented.category.path).toBe(`/${shirts}`);
      expect(reparented.category.parentId).toBeNull();
    });

    it('reparenting shirts back under menswear restores the hierarchy', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch(`/api/catalog/categories/${shirts}/parent`)
        .set('Authorization', auth)
        .send({ newParentSlug: menswear });

      expect(status).toBe(HttpStatus.OK);
      const reparented = body as IReparentBody;
      expect(reparented.category.path).toBe(`/${menswear}/${shirts}`);
      expect(reparented.category.parentId).toBe(menswearId);
      expect(reparented.rewrittenDescendantCount).toBe(1);
    });
  });

  describe('reclassify a product + both browse endpoints', () => {
    const browseProductIds = async (
      slug: string,
      includeDescendants = false,
    ): Promise<number[]> => {
      const query = includeDescendants ? '?includeDescendants=true' : '';
      const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(
        `/api/catalog/categories/${slug}/products${query}`,
      );
      expect(status).toBe(HttpStatus.OK);
      return (body as IPageBody<IProductWithVariantsBody>).items.map((p) => p.id);
    };

    it('attaches the seeded product to menswear and shirts', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/catalog/products/${SEEDED_PRODUCT_ID}/categories`)
        .set('Authorization', auth)
        .send({ categorySlugs: [menswear, shirts] });

      expect(status).toBe(HttpStatus.OK);
      const view = body as IProductCategoriesBody;
      expect(view.product.id).toBe(SEEDED_PRODUCT_ID);
      const ownMemberships = view.categories.map((c) => c.slug).filter((s) => ownSlugs.has(s));
      expect(ownMemberships.sort()).toEqual([menswear, shirts].sort());
    });

    it('both category browse endpoints return the product (public, tokenless)', async () => {
      expect(await browseProductIds(menswear)).toContain(SEEDED_PRODUCT_ID);
      expect(await browseProductIds(shirts)).toContain(SEEDED_PRODUCT_ID);
    });

    it('re-attaching the same slugs is idempotent (200, membership unchanged)', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post(`/api/catalog/products/${SEEDED_PRODUCT_ID}/categories`)
        .set('Authorization', auth)
        .send({ categorySlugs: [menswear, shirts] });

      expect(status).toBe(HttpStatus.OK);
      const ownMemberships = (body as IProductCategoriesBody).categories
        .map((c) => c.slug)
        .filter((s) => ownSlugs.has(s));
      expect(ownMemberships.sort()).toEqual([menswear, shirts].sort());
    });

    it('detaching menswear drops it from that browse but the descendant scope still finds the product', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .delete(`/api/catalog/products/${SEEDED_PRODUCT_ID}/categories/${menswear}`)
        .set('Authorization', auth);

      expect(status).toBe(HttpStatus.OK);
      const ownMemberships = (body as IProductCategoriesBody).categories
        .map((c) => c.slug)
        .filter((s) => ownSlugs.has(s));
      expect(ownMemberships).toEqual([shirts]);

      expect(await browseProductIds(menswear)).not.toContain(SEEDED_PRODUCT_ID);
      expect(await browseProductIds(menswear, true)).toContain(SEEDED_PRODUCT_ID);
      expect(await browseProductIds(shirts)).toContain(SEEDED_PRODUCT_ID);
    });
  });

  describe('cycle detection', () => {
    it('reparenting a category under its own descendant is a 409 CATALOG_CATEGORY_CYCLE', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch(`/api/catalog/categories/${menswear}/parent`)
        .set('Authorization', auth)
        .send({ newParentSlug: oxford });

      expect(status).toBe(HttpStatus.CONFLICT);
      expect((body as IErrorBody).code).toBe('CATALOG_CATEGORY_CYCLE');
    });

    it('reparenting a category under itself is a 409 CATALOG_CATEGORY_CYCLE', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch(`/api/catalog/categories/${menswear}/parent`)
        .set('Authorization', auth)
        .send({ newParentSlug: menswear });

      expect(status).toBe(HttpStatus.CONFLICT);
      expect((body as IErrorBody).code).toBe('CATALOG_CATEGORY_CYCLE');
    });
  });

  describe('authorization + lookup gates', () => {
    it('a tokenless create is 401', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/categories')
        .send({ name: 'Anon', slug: `anon-${stamp}` });

      expect(status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("a customer's token is 403 (no catalog:write)", async () => {
      const auth = await loginCustomer();

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/categories')
        .set('Authorization', auth)
        .send({ name: 'Forbidden', slug: `forbidden-${stamp}` });

      expect(status).toBe(HttpStatus.FORBIDDEN);
    });

    it('creating under an unknown parent slug is a 404', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/categories')
        .set('Authorization', auth)
        .send({ name: 'Orphan', slug: `orphan-${stamp}`, parentSlug: `ghost-${stamp}` });

      expect(status).toBe(HttpStatus.NOT_FOUND);
      expect((body as IErrorBody).code).toBe('CATALOG_CATEGORY_PARENT_NOT_FOUND');
    });

    it('reparenting an unknown slug is a 404', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch(`/api/catalog/categories/ghost-${stamp}/parent`)
        .set('Authorization', auth)
        .send({ newParentSlug: menswear });

      expect(status).toBe(HttpStatus.NOT_FOUND);
      expect((body as IErrorBody).code).toBe('CATALOG_CATEGORY_NOT_FOUND');
    });

    it('creating a duplicate slug is a 409', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/categories')
        .set('Authorization', auth)
        .send({ name: 'Menswear duplicate', slug: menswear });

      expect(status).toBe(HttpStatus.CONFLICT);
      expect((body as IErrorBody).code).toBe('CATALOG_CATEGORY_SLUG_TAKEN');
    });
  });
});
