import { StockItem } from '../stock-item.model';

describe('StockItem', () => {
  describe('construction', () => {
    it('builds with default reservedQuantity of 0', () => {
      const item = new StockItem({ productId: 1, storageId: 'head-warehouse', quantity: 5 });
      expect(item.quantity).toBe(5);
      expect(item.reservedQuantity).toBe(0);
      expect(item.availableQuantity).toBe(5);
    });

    it('rejects negative quantity', () => {
      expect(
        () => new StockItem({ productId: 1, storageId: 'head-warehouse', quantity: -1 }),
      ).toThrow(/quantity must be a non-negative finite number/);
    });

    it('rejects non-finite quantity', () => {
      expect(
        () => new StockItem({ productId: 1, storageId: 'head-warehouse', quantity: Number.NaN }),
      ).toThrow(/quantity must be a non-negative finite number/);
    });

    it('rejects negative reservedQuantity', () => {
      expect(
        () =>
          new StockItem({
            productId: 1,
            storageId: 'head-warehouse',
            quantity: 5,
            reservedQuantity: -1,
          }),
      ).toThrow(/reservedQuantity must be a non-negative finite number/);
    });

    it('rejects reservedQuantity that exceeds quantity', () => {
      expect(
        () =>
          new StockItem({
            productId: 1,
            storageId: 'head-warehouse',
            quantity: 5,
            reservedQuantity: 6,
          }),
      ).toThrow(/reservedQuantity \(6\) must not exceed quantity \(5\)/);
    });
  });

  describe('reserve', () => {
    it('increases reservedQuantity by the given amount', () => {
      const item = new StockItem({ productId: 1, storageId: 'head-warehouse', quantity: 5 });
      item.reserve(2);
      expect(item.reservedQuantity).toBe(2);
      expect(item.availableQuantity).toBe(3);
    });

    it('throws when the requested amount exceeds the available quantity', () => {
      const item = new StockItem({
        productId: 1,
        storageId: 'head-warehouse',
        quantity: 5,
        reservedQuantity: 3,
      });
      expect(() => item.reserve(3)).toThrow(/requested 3 exceeds available 2/);
    });

    it('rejects non-positive amounts', () => {
      const item = new StockItem({ productId: 1, storageId: 'head-warehouse', quantity: 5 });
      expect(() => item.reserve(0)).toThrow(/amount must be a positive finite number/);
      expect(() => item.reserve(-1)).toThrow(/amount must be a positive finite number/);
    });
  });

  describe('release', () => {
    it('decreases reservedQuantity by the given amount', () => {
      const item = new StockItem({
        productId: 1,
        storageId: 'head-warehouse',
        quantity: 5,
        reservedQuantity: 3,
      });
      item.release(2);
      expect(item.reservedQuantity).toBe(1);
      expect(item.availableQuantity).toBe(4);
    });

    it('throws when releasing more than is reserved', () => {
      const item = new StockItem({
        productId: 1,
        storageId: 'head-warehouse',
        quantity: 5,
        reservedQuantity: 1,
      });
      expect(() => item.release(2)).toThrow(/requested 2 exceeds reserved 1/);
    });
  });
});
