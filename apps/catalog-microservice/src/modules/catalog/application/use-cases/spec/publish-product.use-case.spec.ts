import { PinoLogger } from 'nestjs-pino';

import {
  CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA,
  IPublishProductPayload,
  MediaAssetTypeEnum,
  MediaOwnerTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  CatalogDomainException,
  CatalogErrorCodeEnum,
  MediaAsset,
  MediaAssetStatusEnum,
  Product,
  ProductStatusEnum,
  ProductVariant,
  ProductVariantStatusEnum,
} from '../../../domain';
import { PublishProductUseCase } from '../publish-product.use-case';
import {
  InMemoryActivePriceProbe,
  InMemoryCatalogEventsPublisher,
  InMemoryCatalogRepository,
  InMemoryMediaAssetRepository,
} from './test-doubles';

describe('PublishProductUseCase', () => {
  const SEEDED_PRODUCT_ID = 100;
  const SEEDED_VARIANT_ID = 5001;
  const DEFAULT_CURRENCY = 'USD';

  let repository: InMemoryCatalogRepository;
  let publisher: InMemoryCatalogEventsPublisher;
  let priceProbe: InMemoryActivePriceProbe;
  let mediaRepository: InMemoryMediaAssetRepository;
  let logger: PinoLoggerMock;
  let useCase: PublishProductUseCase;

  beforeEach(() => {
    repository = new InMemoryCatalogRepository();
    publisher = new InMemoryCatalogEventsPublisher();
    priceProbe = new InMemoryActivePriceProbe();
    mediaRepository = new InMemoryMediaAssetRepository();
    logger = makePinoLoggerMock();
    useCase = new PublishProductUseCase(
      repository,
      publisher,
      priceProbe,
      DEFAULT_CURRENCY,
      mediaRepository,
      logger as unknown as PinoLogger,
    );
  });

  // Builds an active media asset for an arbitrary owner. The publish soft-warning
  // probe reports media present when ANY product/variant owner has one of these.
  const seedActiveMedia = (ownerType: MediaOwnerTypeEnum, ownerId: number): void => {
    mediaRepository.seed(
      MediaAsset.reconstitute({
        id: ownerId * 10 + (ownerType === MediaOwnerTypeEnum.PRODUCT ? 1 : 2),
        ownerType,
        ownerId,
        uri: 'https://cdn.example.com/hero.jpg',
        type: MediaAssetTypeEnum.IMAGE,
        altText: null,
        sortOrder: 0,
        status: MediaAssetStatusEnum.ACTIVE,
      }),
    );
  };

  const draftVariant = (): ProductVariant =>
    new ProductVariant({
      id: SEEDED_VARIANT_ID,
      productId: SEEDED_PRODUCT_ID,
      sku: 'AERON-BLK-B',
      optionValues: { size: 'B', color: 'black' },
      status: ProductVariantStatusEnum.ACTIVE,
    });

  const seedDraft = (variants: ProductVariant[]): void => {
    repository.seed(
      Product.reconstitute({
        id: SEEDED_PRODUCT_ID,
        name: 'Aeron Chair',
        slug: 'aeron-chair',
        status: ProductStatusEnum.DRAFT,
        variants,
      }),
    );
  };

  const payload: IPublishProductPayload = { productId: SEEDED_PRODUCT_ID, correlationId: 'corr-1' };

  it('publishes a draft product with ≥1 priced variant and emits catalog.product.published', async () => {
    seedDraft([draftVariant()]);
    // The product carries an active media asset, so the soft-warning probe is
    // satisfied and the clean publish carries NO warnings.
    seedActiveMedia(MediaOwnerTypeEnum.PRODUCT, SEEDED_PRODUCT_ID);

    const view = await useCase.execute(payload);

    expect(view.id).toBe(SEEDED_PRODUCT_ID);
    expect(view.status).toBe(ProductStatusEnum.ACTIVE);
    expect(typeof view.publishedAt).toBe('string');

    // A clean publish — `warnings` is absent (`undefined`), never an empty array.
    expect(view.warnings).toBeUndefined();

    expect(repository.saved).toHaveLength(1);
    expect(repository.saved[0].isActive()).toBe(true);

    // The probe was consulted with the product's concrete variant ids and the
    // configured default currency before the transition ran.
    expect(priceProbe.calls).toHaveLength(1);
    expect(priceProbe.calls[0]).toEqual({
      variantIds: [SEEDED_VARIANT_ID],
      currency: DEFAULT_CURRENCY,
    });

    // The wire event carries the concrete variant ids that are now part of the
    // published product, the slug, and the version/correlation envelope.
    expect(publisher.productPublished).toHaveLength(1);
    const [{ event, correlationId }] = publisher.productPublished;
    expect(event.productId).toBe(SEEDED_PRODUCT_ID);
    expect(event.slug).toBe('aeron-chair');
    expect(event.variantIds).toEqual([SEEDED_VARIANT_ID]);
    expect(event.eventVersion).toBe('v1');
    expect(event.publishedAt).toBe(view.publishedAt);
    expect(event.occurredAt).toBe(event.publishedAt);
    expect(event.correlationId).toBe('corr-1');
    expect(correlationId).toBe('corr-1');
  });

  it('rejects publishing when a variant has no active price (PRODUCT_PUBLISH_REQUIRES_PRICE)', async () => {
    seedDraft([draftVariant()]);
    priceProbe.unpriced.add(SEEDED_VARIANT_ID);

    await expect(useCase.execute(payload)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_PRICE,
    });
    await expect(useCase.execute(payload)).rejects.toBeInstanceOf(CatalogDomainException);

    // Hard fail: nothing is persisted and no event is emitted — the probe ran
    // before the transition, so the product never flips to active.
    expect(repository.saved).toHaveLength(0);
    expect(publisher.productPublished).toHaveLength(0);
  });

  it('rejects publishing a product with no variants on the variant rule, not the price probe', async () => {
    seedDraft([]);

    // A variant-less product: the probe is a no-op on the empty id list, so the
    // domain's ≥1-variant rule is what fails — independent of price awareness.
    await expect(useCase.execute(payload)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_VARIANT,
    });
    await expect(useCase.execute(payload)).rejects.toBeInstanceOf(CatalogDomainException);

    expect(repository.saved).toHaveLength(0);
    expect(publisher.productPublished).toHaveLength(0);
  });

  it('rejects when the product does not exist', async () => {
    const orphan: IPublishProductPayload = { productId: 999, correlationId: 'corr-1' };

    await expect(useCase.execute(orphan)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
    });
    expect(repository.saved).toHaveLength(0);
    expect(publisher.productPublished).toHaveLength(0);
    // The not-found check short-circuits before the price probe is reached.
    expect(priceProbe.calls).toHaveLength(0);
  });

  it('still returns the product view when the publish rejects (best-effort post-commit)', async () => {
    seedDraft([draftVariant()]);
    // Active media present, so the only warn log is the event-emit failure below.
    seedActiveMedia(MediaOwnerTypeEnum.PRODUCT, SEEDED_PRODUCT_ID);
    publisher.publishProductPublished = (): Promise<void> => Promise.reject(new Error('rmq-down'));

    const view = await useCase.execute(payload);

    expect(view.status).toBe(ProductStatusEnum.ACTIVE);
    expect(view.warnings).toBeUndefined();
    expect(repository.saved).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-1', productId: SEEDED_PRODUCT_ID }),
      'Failed to publish catalog.product.published event',
    );
  });

  describe('media soft warning (≥1 active media recommended, never a block)', () => {
    it('still publishes a media-less product but surfaces the no-active-media warning', async () => {
      seedDraft([draftVariant()]);
      // No media seeded for the product or its variant.

      const view = await useCase.execute(payload);

      // Publishing PROCEEDED — the recommendation informs, it does not block.
      expect(view.status).toBe(ProductStatusEnum.ACTIVE);
      expect(typeof view.publishedAt).toBe('string');
      expect(repository.saved[0].isActive()).toBe(true);
      // The event still fired — a soft warning is orthogonal to the publish event.
      expect(publisher.productPublished).toHaveLength(1);

      // Exactly one warning, carrying the greppable code.
      expect(view.warnings).toHaveLength(1);
      expect(view.warnings![0].code).toBe(CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA);
      expect(view.warnings![0].code).toBe('CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA');
      expect(view.warnings![0].message).toContain(`Product #${SEEDED_PRODUCT_ID}`);

      // Logged at warn with the correlation + product context.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'corr-1', productId: SEEDED_PRODUCT_ID }),
        'Published product has no active media asset (≥1 recommended)',
      );
    });

    it('omits warnings when an active asset hangs off a VARIANT (not the product)', async () => {
      seedDraft([draftVariant()]);
      // Media on the variant alone still satisfies the "product OR any variant"
      // recommendation.
      seedActiveMedia(MediaOwnerTypeEnum.PRODUCT_VARIANT, SEEDED_VARIANT_ID);

      const view = await useCase.execute(payload);

      expect(view.status).toBe(ProductStatusEnum.ACTIVE);
      expect(view.warnings).toBeUndefined();
    });

    it('probes the product owner pair plus one pair per persisted variant', async () => {
      seedDraft([draftVariant()]);
      const probeSpy = jest.spyOn(mediaRepository, 'hasActiveForOwners');

      await useCase.execute(payload);

      expect(probeSpy).toHaveBeenCalledTimes(1);
      expect(probeSpy).toHaveBeenCalledWith([
        { ownerType: MediaOwnerTypeEnum.PRODUCT, ownerId: SEEDED_PRODUCT_ID },
        { ownerType: MediaOwnerTypeEnum.PRODUCT_VARIANT, ownerId: SEEDED_VARIANT_ID },
      ]);
    });

    it('swallows a probe rejection: publish succeeds, no warning, a warn log (never a throw)', async () => {
      seedDraft([draftVariant()]);
      mediaRepository.hasActiveForOwners = (): Promise<boolean> =>
        Promise.reject(new Error('media-db-down'));

      const view = await useCase.execute(payload);

      // The product is already active — a probe failure cannot un-publish it.
      expect(view.status).toBe(ProductStatusEnum.ACTIVE);
      expect(repository.saved[0].isActive()).toBe(true);
      // No warning is emitted on a probe failure (we cannot prove media is absent).
      expect(view.warnings).toBeUndefined();
      // The failure is warn-logged, not raised.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'corr-1', productId: SEEDED_PRODUCT_ID }),
        'Media soft-warning probe failed; publish unaffected, no warning emitted',
      );
    });
  });
});
