import { IOrderProductConfirm, OrderProductStatusEnum } from '@retail-inventory-system/retail';

import { OrderConfirmDomain } from '../order-confirm.domain';

describe('OrderConfirmDomain', () => {
  const makeProduct = (
    id: number,
    statusId = OrderProductStatusEnum.PENDING,
  ): IOrderProductConfirm => ({
    id,
    productId: id * 10,
    statusId,
  });

  describe('someProductsConfirmed', () => {
    it('is false when confirmedOrderProductIds is empty', () => {
      const result = new OrderConfirmDomain({ id: 1, products: [makeProduct(1)] }, []);

      expect(result.someProductsConfirmed).toBe(false);
    });

    it('is true when confirmedOrderProductIds has at least one entry', () => {
      const result = new OrderConfirmDomain({ id: 1, products: [makeProduct(1)] }, [1]);

      expect(result.someProductsConfirmed).toBe(true);
    });
  });

  describe('allProductsConfirmed', () => {
    it('is false when no products are confirmed and none have CONFIRMED status', () => {
      const result = new OrderConfirmDomain(
        { id: 1, products: [makeProduct(1), makeProduct(2)] },
        [],
      );

      expect(result.allProductsConfirmed).toBe(false);
    });

    it('is true when all products appear in confirmedOrderProductIds', () => {
      const result = new OrderConfirmDomain(
        { id: 1, products: [makeProduct(1), makeProduct(2)] },
        [1, 2],
      );

      expect(result.allProductsConfirmed).toBe(true);
    });

    it('is true when all products already have CONFIRMED status', () => {
      const result = new OrderConfirmDomain(
        {
          id: 1,
          products: [
            makeProduct(1, OrderProductStatusEnum.CONFIRMED),
            makeProduct(2, OrderProductStatusEnum.CONFIRMED),
          ],
        },
        [],
      );

      expect(result.allProductsConfirmed).toBe(true);
    });

    it('is true when products are confirmed via a mix of new IDs and pre-existing CONFIRMED status', () => {
      const result = new OrderConfirmDomain(
        {
          id: 1,
          products: [makeProduct(1), makeProduct(2, OrderProductStatusEnum.CONFIRMED)],
        },
        [1],
      );

      expect(result.allProductsConfirmed).toBe(true);
    });

    it('is false when only some products are confirmed', () => {
      const result = new OrderConfirmDomain(
        { id: 1, products: [makeProduct(1), makeProduct(2)] },
        [1],
      );

      expect(result.allProductsConfirmed).toBe(false);
    });

    it('is true when the order has no products', () => {
      const result = new OrderConfirmDomain({ id: 1, products: [] }, []);

      expect(result.allProductsConfirmed).toBe(true);
    });
  });

  describe('skipUpdate', () => {
    it('is true when no products were newly confirmed and not all are confirmed', () => {
      const result = new OrderConfirmDomain({ id: 1, products: [makeProduct(1)] }, []);

      expect(result.skipUpdate).toBe(true);
    });

    it('is false when some products were newly confirmed', () => {
      const result = new OrderConfirmDomain(
        { id: 1, products: [makeProduct(1), makeProduct(2)] },
        [1],
      );

      expect(result.skipUpdate).toBe(false);
    });

    it('is false when all products are already confirmed with no new confirmations', () => {
      const result = new OrderConfirmDomain(
        { id: 1, products: [makeProduct(1, OrderProductStatusEnum.CONFIRMED)] },
        [],
      );

      expect(result.skipUpdate).toBe(false);
    });
  });
});
