import { PinoLogger } from 'nestjs-pino';

import { ICreateVariantPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  CatalogDomainException,
  CatalogErrorCodeEnum,
  Product,
  ProductStatusEnum,
  ProductVariantStatusEnum,
} from '../../../domain';
import { AddVariantUseCase } from '../add-variant.use-case';
import { InMemoryCatalogEventsPublisher, InMemoryCatalogRepository } from './test-doubles';

describe('AddVariantUseCase', () => {
  const SEEDED_PRODUCT_ID = 100;

  let repository: InMemoryCatalogRepository;
  let publisher: InMemoryCatalogEventsPublisher;
  let logger: PinoLoggerMock;
  let useCase: AddVariantUseCase;

  beforeEach(() => {
    repository = new InMemoryCatalogRepository();
    publisher = new InMemoryCatalogEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = new AddVariantUseCase(repository, publisher, logger as unknown as PinoLogger);

    repository.seed(
      Product.reconstitute({
        id: SEEDED_PRODUCT_ID,
        name: 'Aeron Chair',
        slug: 'aeron-chair',
        status: ProductStatusEnum.DRAFT,
        variants: [],
      }),
    );
  });

  const payload: ICreateVariantPayload = {
    productId: SEEDED_PRODUCT_ID,
    sku: 'AERON-BLK-B',
    gtin: '0123456789012',
    optionValues: { size: 'B', color: 'black' },
    weightG: 20000,
    dimensionsMm: { l: 680, w: 680, h: 1040 },
    correlationId: 'corr-1',
  };

  it('appends the variant, returns the variant view, and emits catalog.variant.created', async () => {
    const view = await useCase.execute(payload);

    expect(view.id).toEqual(expect.any(Number));
    expect(view.productId).toBe(SEEDED_PRODUCT_ID);
    expect(view.sku).toBe('AERON-BLK-B');
    expect(view.gtin).toBe('0123456789012');
    expect(view.optionValues).toEqual({ size: 'B', color: 'black' });
    expect(view.weightG).toBe(20000);
    expect(view.dimensionsMm).toEqual({ l: 680, w: 680, h: 1040 });
    expect(view.status).toBe(ProductVariantStatusEnum.ACTIVE);

    // The wire event carries the concrete, persisted variantId — re-read from
    // the saved aggregate, not the null id the in-process event recorded.
    expect(publisher.published).toHaveLength(1);
    const [{ event, correlationId }] = publisher.published;
    expect(event.productId).toBe(SEEDED_PRODUCT_ID);
    expect(event.variantId).toBe(view.id);
    expect(event.sku).toBe('AERON-BLK-B');
    expect(event.eventVersion).toBe('v1');
    expect(event.correlationId).toBe('corr-1');
    expect(typeof event.occurredAt).toBe('string');
    expect(correlationId).toBe('corr-1');
  });

  it('rejects when the parent product does not exist', async () => {
    const orphan: ICreateVariantPayload = { ...payload, productId: 999 };

    await expect(useCase.execute(orphan)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
    });
    expect(repository.saved).toHaveLength(0);
    expect(publisher.published).toHaveLength(0);
  });

  it('rejects a duplicate sku before persisting', async () => {
    repository.skuTaken = true;

    await expect(useCase.execute(payload)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.VARIANT_SKU_TAKEN,
    });
    await expect(useCase.execute(payload)).rejects.toBeInstanceOf(CatalogDomainException);

    expect(repository.saved).toHaveLength(0);
    expect(publisher.published).toHaveLength(0);
  });

  it('still returns the variant view when the publish rejects (best-effort post-commit)', async () => {
    publisher.publishVariantCreated = (): Promise<void> => Promise.reject(new Error('rmq-down'));

    const view = await useCase.execute(payload);

    expect(view.sku).toBe('AERON-BLK-B');
    expect(repository.saved).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-1', productId: SEEDED_PRODUCT_ID }),
      'Failed to publish catalog.variant.created event',
    );
  });
});
