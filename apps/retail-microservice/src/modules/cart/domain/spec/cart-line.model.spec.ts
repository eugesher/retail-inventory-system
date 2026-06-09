import { CartDomainException, CartLine } from '..';

type CartLineProps = ConstructorParameters<typeof CartLine>[0];

const makeProps = (overrides: Partial<CartLineProps> = {}): CartLineProps => ({
  id: null,
  variantId: 1,
  quantity: 2,
  unitPriceSnapshotMinor: 1500,
  currencySnapshot: 'USD',
  ...overrides,
});

describe('CartLine', () => {
  describe('construction', () => {
    it('builds a line and exposes its fields', () => {
      const line = new CartLine(makeProps());

      expect(line.id).toBeNull();
      expect(line.variantId).toBe(1);
      expect(line.quantity).toBe(2);
      expect(line.unitPriceSnapshotMinor).toBe(1500);
      expect(line.currencySnapshot).toBe('USD');
    });

    it('accepts a zero unitPriceSnapshotMinor (non-negative, e.g. a free line)', () => {
      const line = new CartLine(makeProps({ unitPriceSnapshotMinor: 0 }));
      expect(line.unitPriceSnapshotMinor).toBe(0);
      expect(line.lineSubtotalMinor).toBe(0);
    });

    it.each([
      ['zero variantId', { variantId: 0 }],
      ['negative variantId', { variantId: -1 }],
      ['non-integer variantId', { variantId: 1.5 }],
    ] as const)('rejects a %s', (_label, overrides) => {
      expect(() => new CartLine(makeProps(overrides))).toThrow(CartDomainException);
    });

    it.each([
      ['zero quantity', { quantity: 0 }],
      ['negative quantity', { quantity: -3 }],
      ['non-integer quantity', { quantity: 2.5 }],
    ] as const)('rejects a %s', (_label, overrides) => {
      expect(() => new CartLine(makeProps(overrides))).toThrow(CartDomainException);
    });

    it('rejects a negative unitPriceSnapshotMinor', () => {
      expect(() => new CartLine(makeProps({ unitPriceSnapshotMinor: -1 }))).toThrow(
        CartDomainException,
      );
    });

    it('rejects an empty currencySnapshot', () => {
      expect(() => new CartLine(makeProps({ currencySnapshot: '  ' }))).toThrow(
        CartDomainException,
      );
    });
  });

  describe('lineSubtotalMinor', () => {
    it('is unitPriceSnapshotMinor times quantity', () => {
      const line = new CartLine(makeProps({ unitPriceSnapshotMinor: 1500, quantity: 3 }));
      expect(line.lineSubtotalMinor).toBe(4500);
    });
  });

  describe('changeQuantity', () => {
    it('replaces the quantity with a new positive value', () => {
      const line = new CartLine(makeProps({ quantity: 2 }));
      line.changeQuantity(5);
      expect(line.quantity).toBe(5);
    });

    it('rejects a zero quantity (removal is the explicit op)', () => {
      const line = new CartLine(makeProps({ quantity: 2 }));
      expect(() => line.changeQuantity(0)).toThrow(CartDomainException);
      expect(line.quantity).toBe(2);
    });
  });

  describe('increaseQuantity', () => {
    it('adds the delta to the current quantity', () => {
      const line = new CartLine(makeProps({ quantity: 2 }));
      line.increaseQuantity(3);
      expect(line.quantity).toBe(5);
    });
  });

  describe('snapshot stability across siblings', () => {
    it('leaves line A price snapshot untouched when sibling line B quantity changes', () => {
      const lineA = new CartLine(makeProps({ variantId: 1, unitPriceSnapshotMinor: 1500 }));
      const lineB = new CartLine(makeProps({ variantId: 2, unitPriceSnapshotMinor: 999 }));

      lineB.changeQuantity(10);

      expect(lineA.unitPriceSnapshotMinor).toBe(1500);
      expect(lineA.currencySnapshot).toBe('USD');
      expect(lineA.quantity).toBe(2);
    });
  });
});
