import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { TaxCategory } from '../../../domain';
import { ListTaxCategoriesUseCase } from '../list-tax-categories.use-case';
import { InMemoryPricingRepository } from './test-doubles';

describe('ListTaxCategoriesUseCase', () => {
  let repository: InMemoryPricingRepository;
  let logger: PinoLoggerMock;
  let useCase: ListTaxCategoriesUseCase;

  beforeEach(() => {
    repository = new InMemoryPricingRepository();
    logger = makePinoLoggerMock();
    useCase = new ListTaxCategoriesUseCase(repository, logger as unknown as PinoLogger);
  });

  it('returns an empty array when no categories exist', async () => {
    const views = await useCase.execute({ correlationId: 'corr-1' });

    expect(views).toEqual([]);
  });

  it('returns the persisted set mapped to views', async () => {
    await repository.createTaxCategory(
      TaxCategory.create({ code: 'STANDARD', name: 'Standard rate' }),
    );
    await repository.createTaxCategory(
      TaxCategory.create({ code: 'REDUCED_RATE', name: 'Reduced rate', description: 'Lower band' }),
    );

    const views = await useCase.execute({ correlationId: 'corr-1' });

    expect(views).toHaveLength(2);

    const standard = views.find((view) => view.code === 'STANDARD');
    expect(standard?.id).toEqual(expect.any(Number));
    expect(standard).toMatchObject({
      code: 'STANDARD',
      name: 'Standard rate',
      description: null,
    });

    expect(views.find((view) => view.code === 'REDUCED_RATE')).toMatchObject({
      code: 'REDUCED_RATE',
      name: 'Reduced rate',
      description: 'Lower band',
    });
  });
});
