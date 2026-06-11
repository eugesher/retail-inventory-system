import { PinoLogger } from 'nestjs-pino';

import {
  IAttachMediaPayload,
  MediaAssetTypeEnum,
  MediaOwnerTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  CatalogErrorCodeEnum,
  MediaAsset,
  MediaAssetStatusEnum,
  Product,
  ProductStatusEnum,
  ProductVariant,
} from '../../../domain';
import { AttachMediaUseCase } from '../attach-media.use-case';
import { InMemoryCatalogRepository, InMemoryMediaAssetRepository } from './test-doubles';

// Seeds a persisted product (an attach owner of type `product`).
const seedProduct = (id: number, variants: ProductVariant[] = []): Product =>
  Product.reconstitute({
    id,
    name: `Product ${id}`,
    slug: `product-${id}`,
    status: ProductStatusEnum.ACTIVE,
    variants,
  });

// Seeds a persisted media row at a known slot/status (a pre-existing asset).
const seedMedia = (overrides: {
  id: number;
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
  sortOrder: number;
  status?: MediaAssetStatusEnum;
}): MediaAsset =>
  MediaAsset.reconstitute({
    id: overrides.id,
    ownerType: overrides.ownerType,
    ownerId: overrides.ownerId,
    uri: `https://cdn/${overrides.id}.jpg`,
    type: MediaAssetTypeEnum.IMAGE,
    altText: null,
    sortOrder: overrides.sortOrder,
    status: overrides.status ?? MediaAssetStatusEnum.ACTIVE,
  });

describe('AttachMediaUseCase', () => {
  let mediaRepository: InMemoryMediaAssetRepository;
  let catalogRepository: InMemoryCatalogRepository;
  let logger: PinoLoggerMock;
  let useCase: AttachMediaUseCase;

  beforeEach(() => {
    mediaRepository = new InMemoryMediaAssetRepository();
    catalogRepository = new InMemoryCatalogRepository();
    logger = makePinoLoggerMock();
    useCase = new AttachMediaUseCase(
      mediaRepository,
      catalogRepository,
      logger as unknown as PinoLogger,
    );
  });

  const productPayload = (overrides: Partial<IAttachMediaPayload> = {}): IAttachMediaPayload => ({
    ownerType: MediaOwnerTypeEnum.PRODUCT,
    ownerId: 42,
    uri: 'https://cdn.example.com/img.jpg',
    type: MediaAssetTypeEnum.IMAGE,
    correlationId: 'corr-1',
    ...overrides,
  });

  it('lands the first asset at slot 0', async () => {
    catalogRepository.seed(seedProduct(42));

    const view = await useCase.execute(productPayload());

    expect(view.sortOrder).toBe(0);
    expect(view.id).toEqual(expect.any(Number));
    expect(view.ownerType).toBe(MediaOwnerTypeEnum.PRODUCT);
    expect(view.ownerId).toBe(42);
    expect(view.status).toBe(MediaAssetStatusEnum.ACTIVE);
  });

  it('appends at max+1, counting an ARCHIVED row into the max', async () => {
    catalogRepository.seed(seedProduct(42));
    // Active slots 0 and 1, plus an ARCHIVED row at slot 2 (the highest). The next
    // append must be 3, NOT 2 — archived rows count into the max so a detached
    // slot is never reused.
    mediaRepository.seed(
      seedMedia({ id: 1, ownerType: MediaOwnerTypeEnum.PRODUCT, ownerId: 42, sortOrder: 0 }),
    );
    mediaRepository.seed(
      seedMedia({ id: 2, ownerType: MediaOwnerTypeEnum.PRODUCT, ownerId: 42, sortOrder: 1 }),
    );
    mediaRepository.seed(
      seedMedia({
        id: 3,
        ownerType: MediaOwnerTypeEnum.PRODUCT,
        ownerId: 42,
        sortOrder: 2,
        status: MediaAssetStatusEnum.ARCHIVED,
      }),
    );

    const view = await useCase.execute(productPayload());

    expect(view.sortOrder).toBe(3);
  });

  it('preserves per-owner ordering — attaching to owner B does not disturb owner A', async () => {
    catalogRepository.seed(seedProduct(42));
    catalogRepository.seed(seedProduct(99));
    // Owner A (42) already has two assets at slots 0 and 1.
    mediaRepository.seed(
      seedMedia({ id: 1, ownerType: MediaOwnerTypeEnum.PRODUCT, ownerId: 42, sortOrder: 0 }),
    );
    mediaRepository.seed(
      seedMedia({ id: 2, ownerType: MediaOwnerTypeEnum.PRODUCT, ownerId: 42, sortOrder: 1 }),
    );

    // Attaching to owner B (99) — its first asset lands at slot 0, independent of A.
    const view = await useCase.execute(productPayload({ ownerId: 99 }));

    expect(view.ownerId).toBe(99);
    expect(view.sortOrder).toBe(0);

    // Owner A's strip is untouched: its next append would still be slot 2.
    await expect(mediaRepository.maxSortOrder(MediaOwnerTypeEnum.PRODUCT, 42)).resolves.toBe(1);
  });

  it('attaches to a product-variant owner (resolved via findVariantById)', async () => {
    const variant = new ProductVariant({
      id: 5000,
      productId: 42,
      sku: 'SKU-1',
      optionValues: { color: 'red' },
    });
    catalogRepository.seed(seedProduct(42, [variant]));

    const view = await useCase.execute(
      productPayload({ ownerType: MediaOwnerTypeEnum.PRODUCT_VARIANT, ownerId: 5000 }),
    );

    expect(view.ownerType).toBe(MediaOwnerTypeEnum.PRODUCT_VARIANT);
    expect(view.ownerId).toBe(5000);
    expect(view.sortOrder).toBe(0);
  });

  it('rejects an unknown product owner with MEDIA_OWNER_NOT_FOUND', async () => {
    await expect(useCase.execute(productPayload({ ownerId: 404 }))).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.MEDIA_OWNER_NOT_FOUND,
    });
    expect(mediaRepository.saved).toHaveLength(0);
  });

  it('rejects an unknown product-variant owner with MEDIA_OWNER_NOT_FOUND', async () => {
    await expect(
      useCase.execute(
        productPayload({ ownerType: MediaOwnerTypeEnum.PRODUCT_VARIANT, ownerId: 404 }),
      ),
    ).rejects.toMatchObject({ code: CatalogErrorCodeEnum.MEDIA_OWNER_NOT_FOUND });
    expect(mediaRepository.saved).toHaveLength(0);
  });
});
