import { HttpStatus, INestApplication, INestMicroservice, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as supertest from 'supertest';

import { AppModule as ApiGatewayAppModule } from '@retail-inventory-system/apps/api-gateway';
import { AppModule as CatalogMicroserviceAppModule } from '@retail-inventory-system/apps/catalog-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

// Gateway-only HTTP walk of the polymorphic MediaAsset surface (ADR-029 §4):
// attach-appends-in-order, the all-or-nothing reorder (a non-permutation set is a
// 409 `CATALOG_MEDIA_REORDER_SET_MISMATCH`), detach as a state-guarded archive
// flip (a second detach is a 409), variant-scoped media, and the 401/403/404/400
// gates. The catalog microservice maps each typed `CatalogDomainException` onto an
// HTTP status via `CatalogRpcExceptionFilter`; the gateway's `throwRpcError`
// forwards the typed `code` into the error body.
//
// COLLISION-PROOFING (read before editing). A later session seeds two media rows
// on product 1. To keep this suite green both before and after that seed lands —
// and to survive a second `yarn test:e2e:run` against living infra where prior
// runs leave archived/active media behind — every assertion here is RELATIVE: it
// filters the owner's media strip down to the ids THIS run created and never
// asserts "product 1 has exactly N media". The reorder operation, however, needs
// the request set to be an EXACT permutation of the owner's ACTIVE strip, so the
// suite first CLEAN-SLATES the owner (archives every currently-active asset via
// the public list + the detach route) in `beforeAll` — afterwards the active
// strip is exactly what this run attaches, making the reorder deterministic. The
// `maxSortOrder` append slot counts archived rows, so created `sortOrder`s are
// asserted as strictly ascending, never as fixed values. Only the seeded
// product/variant and the seeded logins are relied on.

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const CUSTOMER_EMAIL = 'customer@example.com';
const CUSTOMER_PASSWORD = 'customer1234';

// Seeded fixtures (scripts/seeds/catalog-product*.sql): product 1 = aurora-desk-lamp
// with variant 1 = AURORA-WARM.
const SEEDED_PRODUCT_ID = 1;
const SEEDED_VARIANT_ID = 1;

interface ITokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface IMediaBody {
  id: number;
  ownerType: string;
  ownerId: number;
  uri: string;
  type: string;
  altText: string | null;
  sortOrder: number;
  status: string;
}

interface IErrorBody {
  statusCode: number;
  message: string | string[];
  code?: string;
}

describe('Catalog media gateway endpoints (e2e)', () => {
  const timeout = 60_000;

  let apiGatewayApp: INestApplication;
  let catalogMicroservice: INestMicroservice;

  // Per-run-unique URIs so the fixtures are visually distinct between runs (the
  // `uri` column is not UNIQUE-constrained, but it keeps a re-run's rows legible).
  const stamp = Date.now();

  // The three product-media ids this run creates (in creation order), and the
  // single variant-media id — every assertion filters the owner strip down to
  // these so the suite stays green amid seeded/prior-run media.
  let productMediaIds: number[] = [];
  let variantMediaId: number;

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

  const listMedia = async (listPath: string): Promise<IMediaBody[]> => {
    const { status, body } = await supertest(apiGatewayApp.getHttpServer()).get(listPath);
    expect(status).toBe(HttpStatus.OK);
    return body as IMediaBody[];
  };

  // CLEAN-SLATE: archive every currently-active asset on the owner so this run
  // owns the entire active strip (the reorder needs an exact active-set
  // permutation). Idempotent and re-run safe — a second pass finds nothing active.
  const clearActiveMedia = async (auth: string, listPath: string): Promise<void> => {
    for (const media of await listMedia(listPath)) {
      await supertest(apiGatewayApp.getHttpServer())
        .delete(`/api/catalog/media/${media.id}`)
        .set('Authorization', auth);
    }
  };

  const attachMedia = async (
    auth: string,
    payload: { ownerType: string; ownerId: number; uri: string; type: string; altText?: string },
  ): Promise<IMediaBody> => {
    const { status, body } = await supertest(apiGatewayApp.getHttpServer())
      .post('/api/catalog/media')
      .set('Authorization', auth)
      .send(payload);
    expect(status).toBe(HttpStatus.CREATED);
    return body as IMediaBody;
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

    const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    await clearActiveMedia(auth, `/api/catalog/products/${SEEDED_PRODUCT_ID}/media`);
    await clearActiveMedia(auth, `/api/catalog/variants/${SEEDED_VARIANT_ID}/media`);
  }, timeout);

  afterAll(async () => {
    await apiGatewayApp?.close();
    await catalogMicroservice?.close();
  });

  describe('attach appends in order', () => {
    it('attaches three assets in ascending slot order and lists them back in that order', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const image = await attachMedia(auth, {
        ownerType: 'product',
        ownerId: SEEDED_PRODUCT_ID,
        uri: `https://cdn.example.com/${stamp}/front.jpg`,
        type: 'image',
        altText: 'Front view',
      });
      const video = await attachMedia(auth, {
        ownerType: 'product',
        ownerId: SEEDED_PRODUCT_ID,
        uri: `https://cdn.example.com/${stamp}/demo.mp4`,
        type: 'video',
      });
      const document = await attachMedia(auth, {
        ownerType: 'product',
        ownerId: SEEDED_PRODUCT_ID,
        uri: `https://cdn.example.com/${stamp}/manual.pdf`,
        type: 'document',
      });

      productMediaIds = [image.id, video.id, document.id];

      // Append slots are strictly ascending in creation order (the absolute
      // values depend on archived siblings, so only the ordering is asserted).
      expect(image.sortOrder).toBeLessThan(video.sortOrder);
      expect(video.sortOrder).toBeLessThan(document.sortOrder);
      expect(image.status).toBe('active');

      // Public browse returns them in creation order (filtered to this run's trio).
      const strip = await listMedia(`/api/catalog/products/${SEEDED_PRODUCT_ID}/media`);
      const ownStrip = strip.filter((m) => productMediaIds.includes(m.id)).map((m) => m.id);
      expect(ownStrip).toEqual(productMediaIds);
    });
  });

  describe('reorder is an atomic permutation', () => {
    it('reorders the strip with the three ids reversed (200)', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
      const reversed = [...productMediaIds].reverse();

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch('/api/catalog/media/reorder')
        .set('Authorization', auth)
        .send({ ownerType: 'product', ownerId: SEEDED_PRODUCT_ID, mediaIdsInOrder: reversed });

      expect(status).toBe(HttpStatus.OK);

      const ownStrip = (body as IMediaBody[])
        .filter((m) => productMediaIds.includes(m.id))
        .map((m) => m.id);
      expect(ownStrip).toEqual(reversed);

      // …and the public browse now reflects the reversed relative order.
      const strip = await listMedia(`/api/catalog/products/${SEEDED_PRODUCT_ID}/media`);
      const browsedOwn = strip.filter((m) => productMediaIds.includes(m.id)).map((m) => m.id);
      expect(browsedOwn).toEqual(reversed);
    });

    it('rejects a non-permutation set with a 409 CATALOG_MEDIA_REORDER_SET_MISMATCH', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
      // Smuggle a foreign id alongside the real trio — not an exact permutation
      // of the active set, so the bulk reorder writes nothing.
      const mismatched = [...productMediaIds, 999_999_999];

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .patch('/api/catalog/media/reorder')
        .set('Authorization', auth)
        .send({ ownerType: 'product', ownerId: SEEDED_PRODUCT_ID, mediaIdsInOrder: mismatched });

      expect(status).toBe(HttpStatus.CONFLICT);
      expect((body as IErrorBody).code).toBe('CATALOG_MEDIA_REORDER_SET_MISMATCH');
    });
  });

  describe('detach is a state-guarded archive flip', () => {
    it('detaches the middle asset and preserves the relative order of the rest', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
      // Current displayed order is the reversed trio; its middle is the same
      // element regardless of direction (the second of three).
      const middleId = productMediaIds[1];
      const survivors = [...productMediaIds].reverse().filter((id) => id !== middleId);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .delete(`/api/catalog/media/${middleId}`)
        .set('Authorization', auth);

      expect(status).toBe(HttpStatus.OK);
      expect((body as IMediaBody).status).toBe('archived');

      const strip = await listMedia(`/api/catalog/products/${SEEDED_PRODUCT_ID}/media`);
      const ownStrip = strip.filter((m) => productMediaIds.includes(m.id)).map((m) => m.id);
      expect(ownStrip).toEqual(survivors);
    });

    it('a second detach of the same asset is a 409 CATALOG_MEDIA_INVALID_STATE_TRANSITION', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
      const middleId = productMediaIds[1];

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .delete(`/api/catalog/media/${middleId}`)
        .set('Authorization', auth);

      expect(status).toBe(HttpStatus.CONFLICT);
      expect((body as IErrorBody).code).toBe('CATALOG_MEDIA_INVALID_STATE_TRANSITION');
    });
  });

  describe('variant-scoped media is independent of the product strip', () => {
    it('attaches media to a variant and lists it without disturbing the product strip', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const productStripBefore = (
        await listMedia(`/api/catalog/products/${SEEDED_PRODUCT_ID}/media`)
      )
        .filter((m) => productMediaIds.includes(m.id))
        .map((m) => m.id);

      const variantMedia = await attachMedia(auth, {
        ownerType: 'product-variant',
        ownerId: SEEDED_VARIANT_ID,
        uri: `https://cdn.example.com/${stamp}/variant-swatch.jpg`,
        type: 'image',
        altText: 'Warm-white swatch',
      });
      variantMediaId = variantMedia.id;
      expect(variantMedia.ownerType).toBe('product-variant');
      expect(variantMedia.ownerId).toBe(SEEDED_VARIANT_ID);

      const variantStrip = await listMedia(`/api/catalog/variants/${SEEDED_VARIANT_ID}/media`);
      expect(variantStrip.map((m) => m.id)).toContain(variantMediaId);

      // The product strip is unchanged — media are owner-scoped by (type, id).
      const productStripAfter = (
        await listMedia(`/api/catalog/products/${SEEDED_PRODUCT_ID}/media`)
      )
        .filter((m) => productMediaIds.includes(m.id))
        .map((m) => m.id);
      expect(productStripAfter).toEqual(productStripBefore);
      expect(productStripAfter).not.toContain(variantMediaId);
    });
  });

  describe('authorization + validation gates', () => {
    it('a tokenless attach is 401', async () => {
      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/media')
        .send({
          ownerType: 'product',
          ownerId: SEEDED_PRODUCT_ID,
          uri: 'https://cdn.example.com/anon.jpg',
          type: 'image',
        });

      expect(status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("a customer's token is 403 (no catalog:write)", async () => {
      const auth = await loginCustomer();

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/media')
        .set('Authorization', auth)
        .send({
          ownerType: 'product',
          ownerId: SEEDED_PRODUCT_ID,
          uri: 'https://cdn.example.com/forbidden.jpg',
          type: 'image',
        });

      expect(status).toBe(HttpStatus.FORBIDDEN);
    });

    it('attaching to an unknown owner id is a 404 CATALOG_MEDIA_OWNER_NOT_FOUND', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status, body } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/media')
        .set('Authorization', auth)
        .send({
          ownerType: 'product',
          ownerId: 999_999_999,
          uri: 'https://cdn.example.com/ghost.jpg',
          type: 'image',
        });

      expect(status).toBe(HttpStatus.NOT_FOUND);
      expect((body as IErrorBody).code).toBe('CATALOG_MEDIA_OWNER_NOT_FOUND');
    });

    it('an unknown asset type is a 400 (DTO edge)', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/media')
        .set('Authorization', auth)
        .send({
          ownerType: 'product',
          ownerId: SEEDED_PRODUCT_ID,
          uri: 'https://cdn.example.com/bad-type.gif',
          type: 'hologram',
        });

      expect(status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('an unknown owner type is a 400 (DTO edge)', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/media')
        .set('Authorization', auth)
        .send({
          ownerType: 'collection',
          ownerId: SEEDED_PRODUCT_ID,
          uri: 'https://cdn.example.com/bad-owner.jpg',
          type: 'image',
        });

      expect(status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('an empty uri is a 400 (DTO edge)', async () => {
      const auth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      const { status } = await supertest(apiGatewayApp.getHttpServer())
        .post('/api/catalog/media')
        .set('Authorization', auth)
        .send({ ownerType: 'product', ownerId: SEEDED_PRODUCT_ID, uri: '', type: 'image' });

      expect(status).toBe(HttpStatus.BAD_REQUEST);
    });
  });
});
