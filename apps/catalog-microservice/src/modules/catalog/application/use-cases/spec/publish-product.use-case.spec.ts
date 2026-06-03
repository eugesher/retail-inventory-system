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
import { InMemoryCatalogEventsPublisher, InMemoryCatalogRepository } from './test-doubles';

describe('PublishProductUseCase', () => {
  const SEEDED_PRODUCT_ID = 100;
  const SEEDED_VARIANT_ID = 5001;

  let repository: InMemoryCatalogRepository;
  let publisher: InMemoryCatalogEventsPublisher;
  let logger: PinoLoggerMock;
  let useCase: PublishProductUseCase;

  beforeEach(() => {
    repository = new InMemoryCatalogRepository();
    publisher = new InMemoryCatalogEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = new PublishProductUseCase(repository, publisher, logger as unknown as PinoLogger);
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

  it('publishes a draft product with ≥1 variant and emits catalog.product.published', async () => {
    seedDraft([draftVariant()]);

    const view = await useCase.execute(payload);

    expect(view.id).toBe(SEEDED_PRODUCT_ID);
    expect(view.status).toBe(ProductStatusEnum.ACTIVE);
    expect(typeof view.publishedAt).toBe('string');

    expect(repository.saved).toHaveLength(1);
    expect(repository.saved[0].isActive()).toBe(true);

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

  it('rejects publishing a product with no variants', async () => {
    seedDraft([]);

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
