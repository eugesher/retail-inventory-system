import { PinoLogger } from 'nestjs-pino';

import { IRegisterProductPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { CatalogDomainException, CatalogErrorCodeEnum, ProductStatusEnum } from '../../../domain';
import { RegisterProductUseCase } from '../register-product.use-case';
import { InMemoryCatalogRepository } from './test-doubles';

describe('RegisterProductUseCase', () => {
  let repository: InMemoryCatalogRepository;
  let logger: PinoLoggerMock;
  let useCase: RegisterProductUseCase;

  beforeEach(() => {
    repository = new InMemoryCatalogRepository();
    logger = makePinoLoggerMock();
    useCase = new RegisterProductUseCase(repository, logger as unknown as PinoLogger);
  });

  const payload: IRegisterProductPayload = {
    name: 'Aeron Chair',
    slug: 'aeron-chair',
    description: 'An ergonomic office chair',
    correlationId: 'corr-1',
  };

  it('persists a draft product and returns the product view', async () => {
    const view = await useCase.execute(payload);

    expect(view.id).toEqual(expect.any(Number));
    expect(view.name).toBe('Aeron Chair');
    expect(view.slug).toBe('aeron-chair');
    expect(view.description).toBe('An ergonomic office chair');
    expect(view.status).toBe(ProductStatusEnum.DRAFT);

    expect(repository.saved).toHaveLength(1);
    const [saved] = repository.saved;
    expect(saved.isDraft()).toBe(true);
    expect(saved.variants).toHaveLength(0);
  });

  it('rejects a duplicate slug before persisting', async () => {
    repository.slugTaken = true;

    await expect(useCase.execute(payload)).rejects.toMatchObject({
      code: CatalogErrorCodeEnum.PRODUCT_SLUG_TAKEN,
    });
    await expect(useCase.execute(payload)).rejects.toBeInstanceOf(CatalogDomainException);

    expect(repository.saved).toHaveLength(0);
  });
});
