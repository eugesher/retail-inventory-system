import { PricingDomainException, PricingErrorCodeEnum, TaxCategory } from '..';

// The typed `code` lives on a property, not in the message — assert on it
// directly rather than matching the human message string.
const expectCode = (fn: () => unknown, code: PricingErrorCodeEnum): void => {
  expect(fn).toThrow(PricingDomainException);
  try {
    fn();
  } catch (error) {
    expect((error as PricingDomainException).code).toBe(code);
  }
};

describe('TaxCategory invariants', () => {
  it('constructs from a valid UPPER_SNAKE_CASE code and a name', () => {
    const category = TaxCategory.create({ code: 'STANDARD', name: 'Standard rate' });

    expect(category.id).toBeNull();
    expect(category.code).toBe('STANDARD');
    expect(category.name).toBe('Standard rate');
    expect(category.description).toBeNull();
  });

  it.each(['STANDARD', 'REDUCED_RATE', 'ZERO_RATED', 'A1_B2'])(
    'accepts the UPPER_SNAKE_CASE code %s',
    (code) => {
      expect(() => TaxCategory.create({ code, name: 'Some rate' })).not.toThrow();
    },
  );

  it.each(['lower', 'Mixed_Case', '1LEADING_DIGIT', 'HAS-DASH', 'HAS SPACE', ''])(
    'rejects the non-UPPER_SNAKE_CASE code %s',
    (code) => {
      expectCode(
        () => TaxCategory.create({ code, name: 'Some rate' }),
        PricingErrorCodeEnum.TAX_CATEGORY_CODE_INVALID,
      );
    },
  );

  it('rejects a blank name', () => {
    expectCode(
      () => TaxCategory.create({ code: 'STANDARD', name: '   ' }),
      PricingErrorCodeEnum.TAX_CATEGORY_NAME_REQUIRED,
    );
  });

  it('throws a PricingDomainException carrying the typed code', () => {
    expectCode(
      () => TaxCategory.create({ code: 'lower', name: 'x' }),
      PricingErrorCodeEnum.TAX_CATEGORY_CODE_INVALID,
    );
  });
});

// `code` uniqueness is a REPOSITORY-level invariant, not a model one (ADR-025
// convention) — the model cannot see other rows. This is what a future
// `CreateTaxCategoryUseCase` will do: pre-check the repository, then persist.
// A minimal in-memory test double stands in for `PricingTypeormRepository`.
describe('TaxCategory code uniqueness (enforced at the repository, not the model)', () => {
  class FakeTaxCategoryStore {
    private readonly rows: TaxCategory[] = [];

    public findByCode(code: string): TaxCategory | null {
      return this.rows.find((row) => row.code === code) ?? null;
    }

    public add(category: TaxCategory): void {
      this.rows.push(category);
    }
  }

  it('lets the model construct two categories with the same code (no self-enforcement)', () => {
    expect(() => {
      TaxCategory.create({ code: 'STANDARD', name: 'First' });
      TaxCategory.create({ code: 'STANDARD', name: 'Second' });
    }).not.toThrow();
  });

  it('detects a duplicate code through the repository pre-check, not the model', () => {
    const store = new FakeTaxCategoryStore();
    store.add(TaxCategory.create({ code: 'STANDARD', name: 'Standard rate' }));

    // The pre-check a use case runs before persisting: a non-null hit means the
    // code is taken and the use case raises TAX_CATEGORY_CODE_TAKEN.
    expect(store.findByCode('STANDARD')).not.toBeNull();
    expect(store.findByCode('REDUCED_RATE')).toBeNull();
  });
});
