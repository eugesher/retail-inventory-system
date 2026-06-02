import { PinoLogger } from 'nestjs-pino';

import { IArchiveProductPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  CatalogDomainException,
  CatalogErrorCodeEnum,
  Product,
  ProductStatusEnum,
} from '../../../domain';
import { ArchiveProductUseCase } from '../archive-product.use-case';
import { InMemoryCatalogEventsPublisher, InMemoryCatalogRepository } from './test-doubles';

describe('ArchiveProductUseCase', () => {
  const SEEDED_PRODUCT_ID = 100;

  let repository: InMemoryCatalogRepository;
  let publisher: InMemoryCatalogEventsPublisher;
  let logger: PinoLoggerMock;
  let useCase: ArchiveProductUseCase;

  beforeEach(() => {
    repository = new InMemoryCatalogRepository();
    publisher = new InMemoryCatalogEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = new ArchiveProductUseCase(repository, publisher, logger as unknown as PinoLogger);
  });

  const seedWithStatus = (status: ProductStatusEnum): void => {
    repository.seed(
      Product.reconstitute({
        id: SEEDED_PRODUCT_ID,
        name: 'Aeron Chair',
        slug: 'aeron-chair',
        status,
        variants: [],
      }),
    );
  };

  const payload: IArchiveProductPayload = { productId: SEEDED_PRODUCT_ID, correlationId: 'corr-1' };

  it('archives an active product and emits catalog.product.archived', async () => {
    seedWithStatus(ProductStatusEnum.ACTIVE);

    const view = await useCase.execute(payload);

    expect(view.id).toBe(SEEDED_PRODUCT_ID);
    expect(view.status).toBe(ProductStatusEnum.ARCHIVED);
    expect(typeof view.archivedAt).toBe('string');

    expect(repository.saved).toHaveLength(1);
    expect(repository.saved[0].isArchived()).toBe(true);

    expect(publisher.productArchived).toHaveLength(1);
    const [{ event, correlationId }] = publisher.productArchived;
    expect(event.productId).toBe(SEEDED_PRODUCT_ID);
    expect(event.eventVersion).toBe('v1');
    expect(event.archivedAt).toBe(view.archivedAt);
    expect(event.occurredAt).toBe(event.archivedAt);
    expect(event.correlationId).toBe('corr-1');
    expect(correlationId).toBe('corr-1');
  });

  it('rejects archiving a non-active product', async () => {
    seedWithStatus(ProductStatusEnum.DRAFT);

    await expect(useCase.execute(payload)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.PRODUCT_INVALID_STATE_TRANSITION,
    });
    await expect(useCase.execute(payload)).rejects.toBeInstanceOf(CatalogDomainException);

    expect(repository.saved).toHaveLength(0);
    expect(publisher.productArchived).toHaveLength(0);
  });

  it('rejects when the product does not exist', async () => {
    const orphan: IArchiveProductPayload = { productId: 999, correlationId: 'corr-1' };

    await expect(useCase.execute(orphan)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
    });
    expect(repository.saved).toHaveLength(0);
    expect(publisher.productArchived).toHaveLength(0);
  });

  it('still returns the product view when the publish rejects (best-effort post-commit)', async () => {
    seedWithStatus(ProductStatusEnum.ACTIVE);
    publisher.publishProductArchived = (): Promise<void> => Promise.reject(new Error('rmq-down'));

    const view = await useCase.execute(payload);

    expect(view.status).toBe(ProductStatusEnum.ARCHIVED);
    expect(repository.saved).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-1', productId: SEEDED_PRODUCT_ID }),
      'Failed to publish catalog.product.archived event',
    );
  });
});
