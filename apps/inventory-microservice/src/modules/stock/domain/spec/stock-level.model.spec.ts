import { InventoryDomainException, InventoryErrorCodeEnum } from '../inventory.exception';
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

  describe('reserve', () => {
    it('raises quantityReserved and bumps the version', () => {
      // available = 10 − 2 − 3 = 5.
      const level = new StockLevel(makeProps({ version: 0 }));
      level.reserve(4);
      expect(level.quantityReserved).toBe(7);
      expect(level.available).toBe(1);
      expect(level.version).toBe(1);
    });

    it('reserves exactly `available` (the boundary) without throwing', () => {
      const level = new StockLevel(makeProps());
      expect(level.available).toBe(5);
      expect(() => level.reserve(5)).not.toThrow();
      expect(level.quantityReserved).toBe(8);
      expect(level.available).toBe(0);
    });

    it('throws OUT_OF_STOCK with details.available when asked for one more than available', () => {
      const level = new StockLevel(makeProps({ version: 2 }));
      let caught: unknown;
      try {
        level.reserve(6); // available is 5
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InventoryDomainException);
      expect((caught as InventoryDomainException).code).toBe(InventoryErrorCodeEnum.OUT_OF_STOCK);
      expect((caught as InventoryDomainException).details).toEqual({ available: 5 });
      // No partial mutation: the rejected reserve neither moved the counter nor
      // bumped the version.
      expect(level.quantityReserved).toBe(3);
      expect(level.version).toBe(2);
    });

    it.each([0, -1, 1.5])(
      'rejects a non-positive / non-integer quantity (%p) as a plain Error',
      (quantity) => {
        const level = new StockLevel(makeProps());
        expect(() => level.reserve(quantity)).toThrow('positive integer');
        // A plain Error, not a typed domain exception (internal caller bug).
        expect(() => level.reserve(quantity)).not.toThrow(InventoryDomainException);
      },
    );
  });

  describe('releaseReserved', () => {
    it('lowers quantityReserved and bumps the version', () => {
      const level = new StockLevel(makeProps({ quantityReserved: 3, version: 0 }));
      level.releaseReserved(2);
      expect(level.quantityReserved).toBe(1);
      expect(level.available).toBe(7);
      expect(level.version).toBe(1);
    });

    it('releasing the full reserved amount returns it all to available', () => {
      const level = new StockLevel(makeProps({ quantityReserved: 3 }));
      level.releaseReserved(3);
      expect(level.quantityReserved).toBe(0);
      expect(level.available).toBe(8);
    });

    it('throws a plain Error (counter drift) when releasing more than is reserved', () => {
      const level = new StockLevel(makeProps({ quantityReserved: 3, version: 4 }));
      expect(() => level.releaseReserved(4)).toThrow('only 3 reserved');
      // Drift is an invariant breach (a 500), not a typed client-facing exception.
      expect(() => level.releaseReserved(4)).not.toThrow(InventoryDomainException);
      expect(level.quantityReserved).toBe(3);
      expect(level.version).toBe(4);
    });

    it('rejects a non-positive / non-integer quantity', () => {
      const level = new StockLevel(makeProps());
      expect(() => level.releaseReserved(0)).toThrow('positive integer');
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
