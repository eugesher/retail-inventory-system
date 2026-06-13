import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';

import { IRecordStockMovementProps, StockMovement } from '../stock-movement.model';

const makeRecordProps = (
  overrides: Partial<IRecordStockMovementProps> = {},
): IRecordStockMovementProps => ({
  variantId: 1,
  stockLocationId: 'default-warehouse',
  type: StockMovementTypeEnum.RECEIPT,
  quantity: 5,
  ...overrides,
});

describe('StockMovement', () => {
  describe('sign-per-type invariant', () => {
    // The fixed-sign reading of ADR-030 §2: positive rows record stock ENTERING
    // on-hand, negative rows record stock LEAVING or a hold being torn down, and
    // `adjustment` carries the operator's signed delta (either sign).
    const positiveTypes = [StockMovementTypeEnum.RECEIPT, StockMovementTypeEnum.RETURN] as const;
    const negativeTypes = [
      StockMovementTypeEnum.SALE,
      StockMovementTypeEnum.ALLOCATION,
      StockMovementTypeEnum.RELEASE,
    ] as const;

    it.each(positiveTypes)('a %s accepts a strictly positive quantity', (type) => {
      const movement = StockMovement.record(makeRecordProps({ type, quantity: 3 }));
      expect(movement.type).toBe(type);
      expect(movement.quantity).toBe(3);
    });

    it.each(positiveTypes)('a %s rejects a negative quantity', (type) => {
      expect(() => StockMovement.record(makeRecordProps({ type, quantity: -3 }))).toThrow(Error);
    });

    it.each(negativeTypes)('a %s accepts a strictly negative quantity', (type) => {
      const movement = StockMovement.record(makeRecordProps({ type, quantity: -4 }));
      expect(movement.type).toBe(type);
      expect(movement.quantity).toBe(-4);
    });

    it.each(negativeTypes)('a %s rejects a positive quantity', (type) => {
      expect(() => StockMovement.record(makeRecordProps({ type, quantity: 4 }))).toThrow(Error);
    });

    it('an adjustment accepts either sign', () => {
      const up = StockMovement.record(
        makeRecordProps({ type: StockMovementTypeEnum.ADJUSTMENT, quantity: 7 }),
      );
      const down = StockMovement.record(
        makeRecordProps({ type: StockMovementTypeEnum.ADJUSTMENT, quantity: -7 }),
      );
      expect(up.quantity).toBe(7);
      expect(down.quantity).toBe(-7);
    });

    const allTypes = [
      ...positiveTypes,
      ...negativeTypes,
      StockMovementTypeEnum.ADJUSTMENT,
    ] as const;

    it.each(allTypes)('a %s rejects a zero quantity', (type) => {
      expect(() => StockMovement.record(makeRecordProps({ type, quantity: 0 }))).toThrow(Error);
    });

    it.each(allTypes)('a %s rejects a non-integer quantity', (type) => {
      // A non-integer of the legal sign for the type still fails on the
      // integer check.
      expect(() => StockMovement.record(makeRecordProps({ type, quantity: 1.5 }))).toThrow(Error);
    });
  });

  describe('immutability (append-only starts in the type system)', () => {
    it('a constructed movement is frozen', () => {
      const movement = StockMovement.record(makeRecordProps());
      expect(Object.isFrozen(movement)).toBe(true);
    });

    it('an attempted field write does not change the value (frozen at runtime)', () => {
      const movement = StockMovement.record(makeRecordProps({ quantity: 5 }));
      try {
        // The cast defeats the compile-time `readonly`; the runtime freeze is what
        // actually holds the line.
        (movement as unknown as { quantity: number }).quantity = 999;
      } catch {
        // A strict-mode write to a frozen property throws; either way the value
        // must be unchanged.
      }
      expect(movement.quantity).toBe(5);
    });

    it('exposes no instance methods at all — no mutators, no getters', () => {
      // Every field is a public readonly data property, so the prototype carries
      // ONLY the constructor: there is no method that could change a recorded
      // movement.
      expect(Object.getOwnPropertyNames(StockMovement.prototype)).toEqual(['constructor']);
    });
  });

  describe('record (write path) defaults', () => {
    it('defaults id to null, occurredAt to ~now, and the nullable fields to null', () => {
      const before = Date.now();
      const movement = StockMovement.record(makeRecordProps());
      const after = Date.now();

      expect(movement.id).toBeNull();
      expect(movement.reasonCode).toBeNull();
      expect(movement.referenceType).toBeNull();
      expect(movement.referenceId).toBeNull();
      expect(movement.actorId).toBeNull();
      expect(movement.occurredAt).toBeInstanceOf(Date);
      expect(movement.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(movement.occurredAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('passes through the optional fields when supplied', () => {
      const occurredAt = new Date('2026-06-13T12:00:00.000Z');
      const movement = StockMovement.record(
        makeRecordProps({
          type: StockMovementTypeEnum.ALLOCATION,
          quantity: -2,
          reasonCode: 'order-placement',
          referenceType: 'order',
          referenceId: '42',
          actorId: 'staff-1',
          occurredAt,
        }),
      );

      expect(movement.reasonCode).toBe('order-placement');
      expect(movement.referenceType).toBe('order');
      expect(movement.referenceId).toBe('42');
      expect(movement.actorId).toBe('staff-1');
      expect(movement.occurredAt).toBe(occurredAt);
    });
  });

  describe('reconstitute (load path)', () => {
    it('round-trips every field', () => {
      const occurredAt = new Date('2026-06-13T09:30:00.000Z');
      const movement = StockMovement.reconstitute({
        id: 99,
        variantId: 7,
        stockLocationId: 'store-1',
        type: StockMovementTypeEnum.RELEASE,
        quantity: -3,
        reasonCode: 'cart-removed',
        referenceType: 'cart',
        referenceId: 'cart-abc',
        actorId: null,
        occurredAt,
      });

      expect(movement.id).toBe(99);
      expect(movement.variantId).toBe(7);
      expect(movement.stockLocationId).toBe('store-1');
      expect(movement.type).toBe(StockMovementTypeEnum.RELEASE);
      expect(movement.quantity).toBe(-3);
      expect(movement.reasonCode).toBe('cart-removed');
      expect(movement.referenceType).toBe('cart');
      expect(movement.referenceId).toBe('cart-abc');
      expect(movement.actorId).toBeNull();
      expect(movement.occurredAt).toBe(occurredAt);
    });

    it('re-asserts the sign invariant on load (a corrupted stored sign is rejected)', () => {
      expect(() =>
        StockMovement.reconstitute({
          id: 1,
          variantId: 1,
          stockLocationId: 'default-warehouse',
          type: StockMovementTypeEnum.RECEIPT,
          quantity: -1, // illegal: a receipt is strictly positive
          reasonCode: null,
          referenceType: null,
          referenceId: null,
          actorId: null,
          occurredAt: new Date(),
        }),
      ).toThrow(Error);
    });
  });
});
