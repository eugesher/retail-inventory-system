import { PinoLogger } from 'nestjs-pino';

import { IPublishProductPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  CatalogDomainException,
  CatalogErrorCodeEnum,
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
} from './test-doubles';

describe('PublishProductUseCase', () => {
  const SEEDED_PRODUCT_ID = 100;
  const SEEDED_VARIANT_ID = 5001;
  const DEFAULT_CURRENCY = 'USD';

  let repository: InMemoryCatalogRepository;
  let publisher: InMemoryCatalogEventsPublisher;
  let priceProbe: InMemoryActivePriceProbe;
  let logger: PinoLoggerMock;
  let useCase: PublishProductUseCase;

  beforeEach(() => {
    repository = new InMemoryCatalogRepository();
    publisher = new InMemoryCatalogEventsPublisher();
    priceProbe = new InMemoryActivePriceProbe();
    logger = makePinoLoggerMock();
    useCase = new PublishProductUseCase(
      repository,
      publisher,
      priceProbe,
      DEFAULT_CURRENCY,
      logger as unknown as PinoLogger,
    );
  });

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

    const view = await useCase.execute(payload);

    expect(view.id).toBe(SEEDED_PRODUCT_ID);
    expect(view.status).toBe(ProductStatusEnum.ACTIVE);
    expect(typeof view.publishedAt).toBe('string');

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
    publisher.publishProductPublished = (): Promise<void> => Promise.reject(new Error('rmq-down'));

    const view = await useCase.execute(payload);

    expect(view.status).toBe(ProductStatusEnum.ACTIVE);
    expect(repository.saved).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-1', productId: SEEDED_PRODUCT_ID }),
      'Failed to publish catalog.product.published event',
    );
  });
});
