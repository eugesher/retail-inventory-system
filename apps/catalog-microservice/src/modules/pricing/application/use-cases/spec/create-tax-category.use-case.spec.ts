import { PinoLogger } from 'nestjs-pino';

import { ICreateTaxCategoryPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { PricingDomainException, PricingErrorCodeEnum } from '../../../domain';
import { CreateTaxCategoryUseCase } from '../create-tax-category.use-case';
import { InMemoryPricingRepository } from './test-doubles';

describe('CreateTaxCategoryUseCase', () => {
  let repository: InMemoryPricingRepository;
  let logger: PinoLoggerMock;
  let useCase: CreateTaxCategoryUseCase;

  beforeEach(() => {
    repository = new InMemoryPricingRepository();
    logger = makePinoLoggerMock();
    useCase = new CreateTaxCategoryUseCase(repository, logger as unknown as PinoLogger);
  });

  const payload: ICreateTaxCategoryPayload = {
    code: 'STANDARD',
    name: 'Standard rate',
    description: 'Default classification',
    correlationId: 'corr-1',
  };

  it('builds and persists a tax category, returning the view with a concrete id', async () => {
    const view = await useCase.execute(payload);

    expect(view.id).toEqual(expect.any(Number));
    expect(view.code).toBe('STANDARD');
    expect(view.name).toBe('Standard rate');
    expect(view.description).toBe('Default classification');

    // It is now resolvable by code (the pre-check path a later create would hit).
    const persisted = await repository.findTaxCategoryByCode('STANDARD');
    expect(persisted?.id).toBe(view.id);
  });

  it('defaults description to null when omitted', async () => {
    const view = await useCase.execute({
      code: 'ZERO_RATED',
      name: 'Zero-rated',
      correlationId: 'corr-1',
    });

    expect(view.description).toBeNull();
  });

  it('rejects a duplicate code with TAX_CATEGORY_CODE_TAKEN', async () => {
    await useCase.execute(payload);

    await expect(useCase.execute({ ...payload, name: 'Another label' })).rejects.toMatchObject({
      code: PricingErrorCodeEnum.TAX_CATEGORY_CODE_TAKEN,
    });
    await expect(useCase.execute({ ...payload, name: 'Another label' })).rejects.toBeInstanceOf(
      PricingDomainException,
    );
  });

  it('rejects a non-UPPER_SNAKE_CASE code via the domain (TAX_CATEGORY_CODE_INVALID)', async () => {
    await expect(useCase.execute({ ...payload, code: 'lower-case' })).rejects.toMatchObject({
      code: PricingErrorCodeEnum.TAX_CATEGORY_CODE_INVALID,
    });

    // A malformed payload must never have reached the repository.
    expect(await repository.listTaxCategories()).toHaveLength(0);
  });
});
