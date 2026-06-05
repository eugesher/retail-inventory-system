import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { PricingDomainException, PricingErrorCodeEnum, TaxCategory } from '../../../domain';
import { AttachTaxCategoryToVariantUseCase } from '../attach-tax-category-to-variant.use-case';
import { InMemoryPricingRepository } from './test-doubles';

describe('AttachTaxCategoryToVariantUseCase', () => {
  const VARIANT_ID = 42;

  let repository: InMemoryPricingRepository;
  let logger: PinoLoggerMock;
  let useCase: AttachTaxCategoryToVariantUseCase;

  beforeEach(() => {
    repository = new InMemoryPricingRepository();
    logger = makePinoLoggerMock();
    useCase = new AttachTaxCategoryToVariantUseCase(repository, logger as unknown as PinoLogger);
  });

  it('attaches the category and returns the updated header with the code populated', async () => {
    const category = await repository.createTaxCategory(
      TaxCategory.create({ code: 'STANDARD', name: 'Standard rate' }),
    );
    repository.seedVariant({ variantId: VARIANT_ID, sku: 'SKU-1' });

    const header = await useCase.execute({
      variantId: VARIANT_ID,
      taxCategoryCode: 'STANDARD',
      correlationId: 'corr-1',
    });

    expect(header).toEqual({
      variantId: VARIANT_ID,
      sku: 'SKU-1',
      taxCategoryId: category.id,
      taxCategoryCode: 'STANDARD',
    });

    // The FK write is durable: re-reading the header resolves the same category.
    const reread = await repository.findVariantTaxHeader(VARIANT_ID);
    expect(reread?.taxCategoryCode).toBe('STANDARD');
  });

  it('re-classifies a variant that already had a category', async () => {
    await repository.createTaxCategory(TaxCategory.create({ code: 'STANDARD', name: 'Standard' }));
    const reduced = await repository.createTaxCategory(
      TaxCategory.create({ code: 'REDUCED_RATE', name: 'Reduced' }),
    );
    repository.seedVariant({ variantId: VARIANT_ID, sku: 'SKU-1' });

    await useCase.execute({
      variantId: VARIANT_ID,
      taxCategoryCode: 'STANDARD',
      correlationId: 'c',
    });
    const header = await useCase.execute({
      variantId: VARIANT_ID,
      taxCategoryCode: 'REDUCED_RATE',
      correlationId: 'c',
    });

    expect(header.taxCategoryId).toBe(reduced.id);
    expect(header.taxCategoryCode).toBe('REDUCED_RATE');
  });

  it('rejects an unknown tax-category code with TAX_CATEGORY_NOT_FOUND', async () => {
    repository.seedVariant({ variantId: VARIANT_ID, sku: 'SKU-1' });

    await expect(
      useCase.execute({ variantId: VARIANT_ID, taxCategoryCode: 'MISSING', correlationId: 'c' }),
    ).rejects.toMatchObject({ code: PricingErrorCodeEnum.TAX_CATEGORY_NOT_FOUND });

    // The variant FK was never touched.
    const header = await repository.findVariantTaxHeader(VARIANT_ID);
    expect(header?.taxCategoryId).toBeNull();
  });

  it('rejects an unknown variant with VARIANT_NOT_FOUND', async () => {
    await repository.createTaxCategory(TaxCategory.create({ code: 'STANDARD', name: 'Standard' }));

    await expect(
      useCase.execute({ variantId: 999, taxCategoryCode: 'STANDARD', correlationId: 'c' }),
    ).rejects.toBeInstanceOf(PricingDomainException);
    await expect(
      useCase.execute({ variantId: 999, taxCategoryCode: 'STANDARD', correlationId: 'c' }),
    ).rejects.toMatchObject({ code: PricingErrorCodeEnum.VARIANT_NOT_FOUND });
  });
});
