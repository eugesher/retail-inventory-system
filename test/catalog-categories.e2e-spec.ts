import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

// Gateway-only HTTP walk of the category surface (ADR-029): hierarchy creation +
// materialized `path`, subtree rebase on reparent, the cycle 409, the reclassify
// idempotency + both browse endpoints, and the 401/403/404/409 gates. The catalog
// microservice maps each typed `CatalogDomainException` onto an HTTP status via
// `CatalogRpcExceptionFilter`, and the gateway's `throwRpcError` forwards both the
// status and the typed `code` (e.g. `CATALOG_CATEGORY_CYCLE`) into the error body.
//
// COLLISION-PROOFING (read before editing). A later session seeds the categories
// `electronics` / `phones` / `apparel`. To keep this suite green both before and
// after that seed lands, every fixture here is API-created from the `menswear`
// family (`menswear` / `shirts` / `trousers` / `oxford` / `clearance`), NEVER the
// reserved seeded three. Each created slug additionally carries a per-run `stamp`
// suffix so a second `yarn test:e2e:run` against living infra does not collide on
// the UNIQUE slug constraint, and every membership assertion is RELATIVE — it
// filters the product's full category list down to THIS run's slugs rather than
// asserting an exact membership size (product 1 accumulates memberships across
// runs and from the future seed). Only the seeded products/variants and the
// seeded logins are relied on.

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

// The seeded active product the reclassify scenario attaches to categories
// (scripts/seeds/catalog-product.sql: product 1 = aurora-desk-lamp).
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

  // Per-run-unique fixtures so re-running against living infra never trips the
  // UNIQUE(slug) constraint. The base names stay in the `menswear` family (never
  // the reserved seeded `electronics`/`phones`/`apparel`).
  const stamp = Date.now();
  const menswear = `menswear-${stamp}`;
  const shirts = `shirts-${stamp}`;
  const trousers = `trousers-${stamp}`;
  const oxford = `oxford-${stamp}`;
  const clearance = `clearance-${stamp}`;
  // Every category this run created — used to filter flat lists + membership
  // views down to this run's rows (the collision-proofing rule).
  const ownSlugs = new Set([menswear, shirts, trousers, oxford, clearance]);

  let menswearId: number;
  let shirtsId: number;

  const login = async (email: string, password: string): Promise<string> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  const loginCustomer = async (): Promise<string> => {
    const { body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/auth/customer/login')
      .send({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
    return `Bearer ${(body as ITokenResponse).accessToken}`;
  };

  // Convenience: create a category and return its parsed body, asserting 201.
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
      // The grandchild oxford is the single rewritten descendant.
      expect(reparented.rewrittenDescendantCount).toBe(1);

      // The descendant rewrite is observable through the tree read: oxford's
      // path was rebased onto the new prefix in the same transaction.
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
        .send({}); // absent newParentSlug → root demotion

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
      // oxford follows shirts back, rebased again.
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
      // Relative assertion: the product's full membership is filtered to THIS
      // run's slugs, both of which must be present.
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

      // Direct membership in menswear is gone.
      expect(await browseProductIds(menswear)).not.toContain(SEEDED_PRODUCT_ID);
      // …but with the subtree scope the product reappears, because it is still
      // attached to shirts, a descendant of menswear (the includeDescendants
      // path-prefix expansion).
      expect(await browseProductIds(menswear, true)).toContain(SEEDED_PRODUCT_ID);
      // And it remains directly in shirts.
      expect(await browseProductIds(shirts)).toContain(SEEDED_PRODUCT_ID);
    });
  });

  describe('cycle detection', () => {
    it('reparenting a category under its own descendant is a 409 CATALOG_CATEGORY_CYCLE', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch(`/api/catalog/categories/${menswear}/parent`)
        .set('Authorization', auth)
        .send({ newParentSlug: oxford }); // oxford is a descendant of menswear

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
