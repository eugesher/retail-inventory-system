import { StockLevel } from '../stock-level.model';

type StockLevelProps = ConstructorParameters<typeof StockLevel>[0];

const makeProps = (overrides: Partial<StockLevelProps> = {}): StockLevelProps => ({
  variantId: 1,
  stockLocationId: 'default-warehouse',
  quantityOnHand: 10,
  quantityAllocated: 2,
  quantityReserved: 3,
  version: 0,
  ...overrides,
});

describe('StockLevel', () => {
  describe('construction', () => {
    it('builds a level and exposes its quantities', () => {
      const level = new StockLevel(makeProps());

      expect(level.variantId).toBe(1);
      expect(level.stockLocationId).toBe('default-warehouse');
      expect(level.quantityOnHand).toBe(10);
      expect(level.quantityAllocated).toBe(2);
      expect(level.quantityReserved).toBe(3);
      expect(level.version).toBe(0);
      expect(level.id).toBeNull();
    });

    it.each([
      ['quantityOnHand', { quantityOnHand: -1 }],
      ['quantityAllocated', { quantityAllocated: -1 }],
      ['quantityReserved', { quantityReserved: -1 }],
      ['version', { version: -1 }],
    ] as const)('rejects a negative %s', (field, overrides) => {
      expect(() => new StockLevel(makeProps(overrides))).toThrow(field);
    });

    it.each([
      ['quantityOnHand', { quantityOnHand: 1.5 }],
      ['quantityReserved', { quantityReserved: 2.5 }],
    ] as const)('rejects a non-integer %s', (field, overrides) => {
      expect(() => new StockLevel(makeProps(overrides))).toThrow(field);
    });
  });

  describe('available', () => {
    it('is onHand minus allocated minus reserved', () => {
      const level = new StockLevel(
        makeProps({ quantityOnHand: 10, quantityAllocated: 2, quantityReserved: 3 }),
      );
      expect(level.available).toBe(5);
    });

    it('can be negative when commitments exceed on-hand (no invariant guards it yet)', () => {
      const level = new StockLevel(
        makeProps({ quantityOnHand: 1, quantityAllocated: 2, quantityReserved: 3 }),
      );
      expect(level.available).toBe(-4);
    });
  });

  describe('changeOnHand', () => {
    it('applies a positive delta and bumps the version', () => {
      const level = new StockLevel(makeProps({ quantityOnHand: 10, version: 0 }));
      level.changeOnHand(5);
      expect(level.quantityOnHand).toBe(15);
      expect(level.version).toBe(1);
    });

    it('applies a negative delta and bumps the version', () => {
      const level = new StockLevel(makeProps({ quantityOnHand: 10, version: 4 }));
      level.changeOnHand(-4);
      expect(level.quantityOnHand).toBe(6);
      expect(level.version).toBe(5);
    });

    it('increments the version on every mutation', () => {
      const level = new StockLevel(makeProps({ quantityOnHand: 10, version: 0 }));
      level.changeOnHand(1);
      level.changeOnHand(1);
      level.changeOnHand(-2);
      expect(level.quantityOnHand).toBe(10);
      expect(level.version).toBe(3);
    });

    it('rejects a delta that would drive on-hand negative (and does not bump version)', () => {
      const level = new StockLevel(makeProps({ quantityOnHand: 3, version: 7 }));
      expect(() => level.changeOnHand(-4)).toThrow('negative');
      expect(level.quantityOnHand).toBe(3);
      expect(level.version).toBe(7);
    });

    it('rejects a non-integer delta', () => {
      const level = new StockLevel(makeProps());
      expect(() => level.changeOnHand(1.5)).toThrow('integer');
    });
  });

  describe('initialAt', () => {
    it('yields a zeroed level at version 0', () => {
      const level = StockLevel.initialAt(42, 'default-warehouse');

      expect(level.variantId).toBe(42);
      expect(level.stockLocationId).toBe('default-warehouse');
      expect(level.quantityOnHand).toBe(0);
      expect(level.quantityAllocated).toBe(0);
      expect(level.quantityReserved).toBe(0);
      expect(level.version).toBe(0);
      expect(level.available).toBe(0);
      expect(level.id).toBeNull();
    });
  });
});
