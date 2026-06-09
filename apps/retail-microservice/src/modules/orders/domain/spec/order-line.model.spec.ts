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
    it('exposes sku / nameSnapshot / unitPriceMinor as getter-only (no setters)', () => {
      const line = new OrderLine({ ...baseProps });

      // The snapshot fields are `readonly` — assigning through them throws in strict
      // mode and the value never changes; they are the buyer's contract, decoupled
      // from any later catalog change.
      expect(() => {
        (line as unknown as { sku: string }).sku = 'SKU-X';
      }).toThrow();
      expect(() => {
        (line as unknown as { nameSnapshot: string }).nameSnapshot = 'Renamed';
      }).toThrow();
      expect(() => {
        (line as unknown as { unitPriceMinor: number }).unitPriceMinor = 9999;
      }).toThrow();

      expect(line.sku).toBe('SKU-7');
      expect(line.nameSnapshot).toBe('Blue Widget');
      expect(line.unitPriceMinor).toBe(1500);
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
