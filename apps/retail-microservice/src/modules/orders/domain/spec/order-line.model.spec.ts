import { OrderLineStatusEnum } from '@retail-inventory-system/contracts';

import { OrderLine, OrderDomainException } from '..';

const baseProps = {
  id: null as number | null,
  variantId: 7,
  sku: 'SKU-7',
  nameSnapshot: 'Blue Widget',
  quantity: 3,
  unitPriceMinor: 1500,
};

describe('OrderLine', () => {
  describe('construction', () => {
    it('builds a line and derives lineTotalMinor from unitPriceMinor × quantity', () => {
      const line = new OrderLine({ ...baseProps });

      // 1500 × 3 = 4500 (tax/discount default 0)
      expect(line.lineTotalMinor).toBe(4500);
      expect(line.taxAmountMinor).toBe(0);
      expect(line.discountAmountMinor).toBe(0);
    });

    it('defaults status to the ALLOCATED sentinel', () => {
      const line = new OrderLine({ ...baseProps });
      expect(line.status).toBe(OrderLineStatusEnum.ALLOCATED);
    });

    it('derives lineTotalMinor with tax and discount when present', () => {
      const line = new OrderLine({
        ...baseProps,
        quantity: 2,
        unitPriceMinor: 1000,
        taxAmountMinor: 150,
        discountAmountMinor: 50,
      });
      // 1000 × 2 + 150 − 50 = 2100
      expect(line.lineTotalMinor).toBe(2100);
    });

    it('rejects a supplied lineTotalMinor that disagrees with the formula', () => {
      expect(
        () =>
          new OrderLine({ ...baseProps, quantity: 2, unitPriceMinor: 1000, lineTotalMinor: 1999 }),
      ).toThrow(OrderDomainException);
    });
  });

  describe('snapshot immutability', () => {
    it('keeps the money/identity snapshot intact across a status mutation', () => {
      const line = new OrderLine({ ...baseProps });

      // `status` is the only mutable field — advancing it must not disturb the
      // place-time price/identity snapshot (the buyer's contract, decoupled from any
      // later catalog change). The snapshot fields are `readonly` (compile-time
      // immutable, no setter); only `markFulfillment` can move `status`.
      line.markFulfillment(OrderLineStatusEnum.SHIPPED);

      expect(line.status).toBe(OrderLineStatusEnum.SHIPPED);
      expect(line.sku).toBe('SKU-7');
      expect(line.nameSnapshot).toBe('Blue Widget');
      expect(line.unitPriceMinor).toBe(1500);
      expect(line.lineTotalMinor).toBe(4500);
    });
  });

  describe('markFulfillment', () => {
    it('advances allocated → partially-shipped → shipped', () => {
      const line = new OrderLine({ ...baseProps });

      line.markFulfillment(OrderLineStatusEnum.PARTIALLY_SHIPPED);
      expect(line.status).toBe(OrderLineStatusEnum.PARTIALLY_SHIPPED);

      line.markFulfillment(OrderLineStatusEnum.SHIPPED);
      expect(line.status).toBe(OrderLineStatusEnum.SHIPPED);
    });

    it('advances allocated → shipped directly (a full single ship)', () => {
      const line = new OrderLine({ ...baseProps });
      line.markFulfillment(OrderLineStatusEnum.SHIPPED);
      expect(line.status).toBe(OrderLineStatusEnum.SHIPPED);
    });

    it('is an idempotent no-op when the status is unchanged', () => {
      const line = new OrderLine({ ...baseProps });
      line.markFulfillment(OrderLineStatusEnum.SHIPPED);
      expect(() => line.markFulfillment(OrderLineStatusEnum.SHIPPED)).not.toThrow();
      expect(line.status).toBe(OrderLineStatusEnum.SHIPPED);
    });

    it('rejects a strictly-backward move (shipped → partially-shipped)', () => {
      const line = new OrderLine({ ...baseProps });
      line.markFulfillment(OrderLineStatusEnum.SHIPPED);
      // A backward move is an internal-invariant breach the use case never produces —
      // a plain Error (500), not a typed domain rejection.
      expect(() => line.markFulfillment(OrderLineStatusEnum.PARTIALLY_SHIPPED)).toThrow();
    });

    it('rejects a status outside the fulfillment-progress subset', () => {
      const line = new OrderLine({ ...baseProps });
      expect(() => line.markFulfillment(OrderLineStatusEnum.CANCELLED)).toThrow();
    });
  });

  describe('invariants', () => {
    it('rejects a non-positive variantId', () => {
      expect(() => new OrderLine({ ...baseProps, variantId: 0 })).toThrow(OrderDomainException);
    });

    it('rejects a non-positive quantity', () => {
      expect(() => new OrderLine({ ...baseProps, quantity: 0 })).toThrow(OrderDomainException);
    });

    it('rejects an empty sku', () => {
      expect(() => new OrderLine({ ...baseProps, sku: '  ' })).toThrow(OrderDomainException);
    });

    it('rejects an empty nameSnapshot', () => {
      expect(() => new OrderLine({ ...baseProps, nameSnapshot: '' })).toThrow(OrderDomainException);
    });

    it('rejects a negative unitPriceMinor', () => {
      expect(() => new OrderLine({ ...baseProps, unitPriceMinor: -1 })).toThrow(
        OrderDomainException,
      );
    });
  });
});
