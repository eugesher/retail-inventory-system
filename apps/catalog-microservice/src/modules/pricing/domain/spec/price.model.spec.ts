import { Price, PricingDomainException, PricingErrorCodeEnum } from '..';

// A fixed "now" so the past/future guards are deterministic regardless of when
// the suite runs.
const NOW = new Date('2026-06-04T12:00:00.000Z');
const PAST = new Date('2026-06-04T11:59:59.000Z');
const FUTURE = new Date('2026-06-05T12:00:00.000Z');

const validSet = {
  variantId: 42,
  currency: 'USD',
  amountMinor: 1999,
};

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

describe('Price.set — the standard write path', () => {
  it('builds an open price, defaulting validFrom to now, validTo to null, priority to 0', () => {
    const price = Price.set(validSet, NOW);

    expect(price.id).toBeNull();
    expect(price.variantId).toBe(42);
    expect(price.currency).toBe('USD');
    expect(price.amountMinor).toBe(1999);
    expect(price.validFrom).toBe(NOW);
    expect(price.validTo).toBeNull();
    expect(price.priority).toBe(0);
    expect(price.isOpen()).toBe(true);
  });

  it('rejects a validFrom strictly before now (append-only: no past authoring)', () => {
    expectCode(
      () => Price.set({ ...validSet, validFrom: PAST }, NOW),
      PricingErrorCodeEnum.PRICE_VALID_FROM_IN_PAST,
    );
  });

  it('accepts a future validFrom (a scheduled price)', () => {
    expect(() => Price.set({ ...validSet, validFrom: FUTURE }, NOW)).not.toThrow();
  });

  it('accepts a validFrom exactly equal to now (the boundary is inclusive)', () => {
    expect(() => Price.set({ ...validSet, validFrom: NOW }, NOW)).not.toThrow();
  });
});

describe('Price.reconstitute — the persistence load path', () => {
  it('accepts a past validFrom with no guard (history is materialized here)', () => {
    const price = Price.reconstitute({
      id: 7,
      variantId: 42,
      currency: 'USD',
      amountMinor: 1500,
      validFrom: PAST,
      validTo: NOW,
      priority: 0,
    });

    expect(price.id).toBe(7);
    expect(price.validFrom).toBe(PAST);
    expect(price.isOpen()).toBe(false);
  });
});

describe('Price invariants', () => {
  it('rejects a negative amountMinor', () => {
    expectCode(
      () => Price.set({ ...validSet, amountMinor: -1 }, NOW),
      PricingErrorCodeEnum.PRICE_AMOUNT_INVALID,
    );
  });

  it('rejects a non-integer amountMinor', () => {
    expectCode(
      () => Price.set({ ...validSet, amountMinor: 19.99 }, NOW),
      PricingErrorCodeEnum.PRICE_AMOUNT_INVALID,
    );
  });

  it('accepts a zero amountMinor (free / non-negative boundary)', () => {
    expect(() => Price.set({ ...validSet, amountMinor: 0 }, NOW)).not.toThrow();
  });

  it.each(['usd', 'US', 'USDD', 'US1', ''])(
    'rejects a currency that is not the 3-uppercase-letter ISO shape: %s',
    (currency) => {
      expectCode(
        () => Price.set({ ...validSet, currency }, NOW),
        PricingErrorCodeEnum.PRICE_CURRENCY_INVALID,
      );
    },
  );

  it('rejects a closed interval where validFrom is not strictly before validTo', () => {
    expectCode(
      () => Price.set({ ...validSet, validFrom: FUTURE, validTo: FUTURE }, NOW),
      PricingErrorCodeEnum.PRICE_INTERVAL_INVALID,
    );
  });

  it('rejects a non-integer priority', () => {
    expectCode(
      () => Price.set({ ...validSet, priority: 1.5 }, NOW),
      PricingErrorCodeEnum.PRICE_PRIORITY_INVALID,
    );
  });
});

describe('Price.close — the only permitted mutation', () => {
  it('produces a closed row and leaves the value fields untouched', () => {
    const open = Price.reconstitute({
      id: 7,
      variantId: 42,
      currency: 'USD',
      amountMinor: 1999,
      validFrom: PAST,
      validTo: null,
      priority: 3,
    });

    const closed = open.close(NOW);

    expect(closed.validTo).toBe(NOW);
    expect(closed.isOpen()).toBe(false);
    // Value fields are carried verbatim — append-only-for-history means a close
    // never edits the amount/currency/variant/priority.
    expect(closed.id).toBe(7);
    expect(closed.variantId).toBe(42);
    expect(closed.currency).toBe('USD');
    expect(closed.amountMinor).toBe(1999);
    expect(closed.validFrom).toBe(PAST);
    expect(closed.priority).toBe(3);
    // The original instance is unchanged (close returns a new Price).
    expect(open.isOpen()).toBe(true);
  });

  it('rejects closing at a time at-or-before validFrom (an empty interval)', () => {
    const open = Price.set({ ...validSet, validFrom: FUTURE }, NOW);
    expectCode(() => open.close(FUTURE), PricingErrorCodeEnum.PRICE_INTERVAL_INVALID);
  });
});
