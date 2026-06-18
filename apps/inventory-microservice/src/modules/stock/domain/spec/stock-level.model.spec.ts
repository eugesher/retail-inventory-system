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

  describe('allocateFromReserved', () => {
    it('moves units from reserved to allocated, leaving available unchanged, and bumps the version', () => {
      // onHand 10, allocated 2, reserved 3 → available 5.
      const level = new StockLevel(makeProps({ version: 0 }));
      level.allocateFromReserved(2);
      expect(level.quantityReserved).toBe(1);
      expect(level.quantityAllocated).toBe(4);
      // A pure reserved → allocated transfer: both subtract from available, so it
      // is unchanged.
      expect(level.available).toBe(5);
      expect(level.version).toBe(1);
    });

    it('moves exactly the reserved amount (the boundary) without throwing', () => {
      const level = new StockLevel(makeProps({ quantityReserved: 3 }));
      expect(() => level.allocateFromReserved(3)).not.toThrow();
      expect(level.quantityReserved).toBe(0);
      expect(level.quantityAllocated).toBe(5);
    });

    it('throws a plain Error (counter drift) when moving more than is reserved', () => {
      const level = new StockLevel(makeProps({ quantityReserved: 3, version: 4 }));
      expect(() => level.allocateFromReserved(4)).toThrow('only 3 reserved');
      // Drift is an invariant breach (a 500), not a typed client-facing exception.
      expect(() => level.allocateFromReserved(4)).not.toThrow(InventoryDomainException);
      expect(level.quantityReserved).toBe(3);
      expect(level.quantityAllocated).toBe(2);
      expect(level.version).toBe(4);
    });

    it.each([0, -1, 1.5])('rejects a non-positive / non-integer quantity (%p)', (quantity) => {
      const level = new StockLevel(makeProps());
      expect(() => level.allocateFromReserved(quantity)).toThrow('positive integer');
    });
  });

  describe('allocateDirect', () => {
    it('raises allocated, lowers available, and bumps the version', () => {
      // available = 5.
      const level = new StockLevel(makeProps({ version: 0 }));
      level.allocateDirect(4);
      expect(level.quantityAllocated).toBe(6);
      expect(level.available).toBe(1);
      expect(level.version).toBe(1);
    });

    it('allocates exactly `available` (the boundary) without throwing', () => {
      const level = new StockLevel(makeProps());
      expect(level.available).toBe(5);
      expect(() => level.allocateDirect(5)).not.toThrow();
      expect(level.quantityAllocated).toBe(7);
      expect(level.available).toBe(0);
    });

    it('throws OUT_OF_STOCK with details.available when asked for one more than available', () => {
      const level = new StockLevel(makeProps({ version: 2 }));
      let caught: unknown;
      try {
        level.allocateDirect(6); // available is 5
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InventoryDomainException);
      expect((caught as InventoryDomainException).code).toBe(InventoryErrorCodeEnum.OUT_OF_STOCK);
      expect((caught as InventoryDomainException).details).toEqual({ available: 5 });
      // No partial mutation.
      expect(level.quantityAllocated).toBe(2);
      expect(level.version).toBe(2);
    });

    it.each([0, -1, 1.5])('rejects a non-positive / non-integer quantity (%p)', (quantity) => {
      const level = new StockLevel(makeProps());
      expect(() => level.allocateDirect(quantity)).toThrow('positive integer');
      // A plain Error, not a typed domain exception (internal caller bug).
      expect(() => level.allocateDirect(quantity)).not.toThrow(InventoryDomainException);
    });
  });

  describe('releaseAllocated', () => {
    it('lowers allocated, raises available, and bumps the version', () => {
      const level = new StockLevel(makeProps({ quantityAllocated: 2, version: 0 }));
      level.releaseAllocated(2);
      expect(level.quantityAllocated).toBe(0);
      expect(level.available).toBe(7);
      expect(level.version).toBe(1);
    });

    it('releasing the full allocated amount returns it all to available', () => {
      const level = new StockLevel(makeProps({ quantityAllocated: 2 }));
      level.releaseAllocated(2);
      expect(level.quantityAllocated).toBe(0);
      expect(level.available).toBe(7);
    });

    it('throws STOCK_RESULT_NEGATIVE (a user-reachable 409) when releasing more than is allocated', () => {
      const level = new StockLevel(makeProps({ quantityAllocated: 2, version: 4 }));
      let caught: unknown;
      try {
        level.releaseAllocated(3);
      } catch (error) {
        caught = error;
      }
      // Unlike allocateFromReserved's drift (a 500), an over-cancel IS reachable
      // (a Cancel RPC with a wrong quantity) — a typed 409, not a plain Error.
      expect(caught).toBeInstanceOf(InventoryDomainException);
      expect((caught as InventoryDomainException).code).toBe(
        InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE,
      );
      expect(level.quantityAllocated).toBe(2);
      expect(level.version).toBe(4);
    });

    it.each([0, -1, 1.5])('rejects a non-positive / non-integer quantity (%p)', (quantity) => {
      const level = new StockLevel(makeProps());
      expect(() => level.releaseAllocated(quantity)).toThrow('positive integer');
    });
  });

  describe('commitSale', () => {
    it('decrements on-hand AND allocated in one version bump, leaving available unchanged', () => {
      // onHand 10, allocated 2, reserved 3 → available 5.
      const level = new StockLevel(makeProps({ version: 0 }));
      level.commitSale(2);
      expect(level.quantityOnHand).toBe(8);
      expect(level.quantityAllocated).toBe(0);
      expect(level.quantityReserved).toBe(3);
      // Both decremented counters subtract from available, so it is unchanged: a
      // commit-sale neither frees nor consumes sellable stock.
      expect(level.available).toBe(5);
      // ONE mutation despite two counters moving.
      expect(level.version).toBe(1);
    });

    it('ships exactly the allocated amount (the boundary) without throwing', () => {
      const level = new StockLevel(
        makeProps({ quantityOnHand: 10, quantityAllocated: 4, quantityReserved: 0 }),
      );
      expect(() => level.commitSale(4)).not.toThrow();
      expect(level.quantityOnHand).toBe(6);
      expect(level.quantityAllocated).toBe(0);
    });

    it('throws a plain Error (allocated drift) when shipping more than is allocated', () => {
      const level = new StockLevel(
        makeProps({ quantityOnHand: 10, quantityAllocated: 2, quantityReserved: 0, version: 4 }),
      );
      expect(() => level.commitSale(3)).toThrow('only 2 allocated');
      // Drift is an invariant breach (a 500), not a typed client-facing exception.
      expect(() => level.commitSale(3)).not.toThrow(InventoryDomainException);
      expect(level.quantityOnHand).toBe(10);
      expect(level.quantityAllocated).toBe(2);
      expect(level.version).toBe(4);
    });

    it('throws STOCK_RESULT_NEGATIVE (a user-reachable 409) when on-hand fell below allocated', () => {
      // A prior negative adjust drove on-hand below the allocated amount.
      const level = new StockLevel(
        makeProps({ quantityOnHand: 1, quantityAllocated: 3, quantityReserved: 0, version: 2 }),
      );
      let caught: unknown;
      try {
        level.commitSale(3); // allocated allows it, but on-hand (1) does not
      } catch (error) {
        caught = error;
      }
      // The allocated guard passes (3 ≤ 3); the on-hand guard rejects — and because an
      // operator can reach this via a prior adjust, it is a typed 409, not a 500.
      expect(caught).toBeInstanceOf(InventoryDomainException);
      expect((caught as InventoryDomainException).code).toBe(
        InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE,
      );
      // No partial mutation.
      expect(level.quantityOnHand).toBe(1);
      expect(level.quantityAllocated).toBe(3);
      expect(level.version).toBe(2);
    });

    it.each([0, -1, 1.5])('rejects a non-positive / non-integer quantity (%p)', (quantity) => {
      const level = new StockLevel(makeProps());
      expect(() => level.commitSale(quantity)).toThrow('positive integer');
      // A plain Error, not a typed domain exception (internal caller bug).
      expect(() => level.commitSale(quantity)).not.toThrow(InventoryDomainException);
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
