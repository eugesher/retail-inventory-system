import { OrderProductStatusEnum, OrderStatusEnum } from '@retail-inventory-system/contracts';

import {
  CustomerRef,
  Order,
  OrderConfirmedEvent,
  OrderProduct,
  OrderProductStatusVO,
  OrderStatusVO,
} from '..';

const customer = new CustomerRef({ id: 1 });

const makeProduct = (id: number, statusId = OrderProductStatusEnum.PENDING): OrderProduct =>
  new OrderProduct({
    id,
    productId: id * 10,
    status:
      statusId === OrderProductStatusEnum.CONFIRMED
        ? OrderProductStatusVO.CONFIRMED
        : OrderProductStatusVO.PENDING,
  });

const makeOrder = (products: OrderProduct[], statusId = OrderStatusEnum.PENDING): Order =>
  Order.reconstitute({
    id: 1,
    customer,
    products,
    status:
      statusId === OrderStatusEnum.CONFIRMED ? OrderStatusVO.CONFIRMED : OrderStatusVO.PENDING,
  });

describe('Order.applyInventoryConfirmation', () => {
  describe('someProductsConfirmed', () => {
    it('is false when confirmedOrderProductIds is empty', () => {
      const order = makeOrder([makeProduct(1)]);

      const result = order.applyInventoryConfirmation([]);

      expect(result.someProductsConfirmed).toBe(false);
    });

    it('is true when confirmedOrderProductIds has at least one entry', () => {
      const order = makeOrder([makeProduct(1)]);

      const result = order.applyInventoryConfirmation([1]);

      expect(result.someProductsConfirmed).toBe(true);
    });
  });

  describe('allProductsConfirmed', () => {
    it('is false when no products are confirmed and none have CONFIRMED status', () => {
      const order = makeOrder([makeProduct(1), makeProduct(2)]);

      const result = order.applyInventoryConfirmation([]);

      expect(result.allProductsConfirmed).toBe(false);
    });

    it('is true when all products appear in confirmedOrderProductIds', () => {
      const order = makeOrder([makeProduct(1), makeProduct(2)]);

      const result = order.applyInventoryConfirmation([1, 2]);

      expect(result.allProductsConfirmed).toBe(true);
    });

    it('is true when all products already have CONFIRMED status', () => {
      const order = makeOrder([
        makeProduct(1, OrderProductStatusEnum.CONFIRMED),
        makeProduct(2, OrderProductStatusEnum.CONFIRMED),
      ]);

      const result = order.applyInventoryConfirmation([]);

      expect(result.allProductsConfirmed).toBe(true);
    });

    it('is true when products are confirmed via a mix of new IDs and pre-existing CONFIRMED status', () => {
      const order = makeOrder([makeProduct(1), makeProduct(2, OrderProductStatusEnum.CONFIRMED)]);

      const result = order.applyInventoryConfirmation([1]);

      expect(result.allProductsConfirmed).toBe(true);
    });

    it('is false when only some products are confirmed', () => {
      const order = makeOrder([makeProduct(1), makeProduct(2)]);

      const result = order.applyInventoryConfirmation([1]);

      expect(result.allProductsConfirmed).toBe(false);
    });
  });

  describe('skipUpdate', () => {
    it('is true when no products were newly confirmed and not all are confirmed', () => {
      const order = makeOrder([makeProduct(1)]);

      const result = order.applyInventoryConfirmation([]);

      expect(result.skipUpdate).toBe(true);
    });

    it('is false when some products were newly confirmed', () => {
      const order = makeOrder([makeProduct(1), makeProduct(2)]);

      const result = order.applyInventoryConfirmation([1]);

      expect(result.skipUpdate).toBe(false);
    });

    it('is false when all products are already confirmed with no new confirmations', () => {
      const order = makeOrder([makeProduct(1, OrderProductStatusEnum.CONFIRMED)]);

      const result = order.applyInventoryConfirmation([]);

      expect(result.skipUpdate).toBe(false);
    });
  });

  describe('side effects', () => {
    it('transitions newly-confirmed lines to CONFIRMED on the aggregate', () => {
      const order = makeOrder([makeProduct(1), makeProduct(2)]);

      order.applyInventoryConfirmation([1]);

      expect(order.products[0].isConfirmed()).toBe(true);
      expect(order.products[1].isConfirmed()).toBe(false);
    });

    it('flips the order header to CONFIRMED and records OrderConfirmed when every line is confirmed', () => {
      const order = makeOrder([makeProduct(1), makeProduct(2)]);

      order.applyInventoryConfirmation([1, 2]);

      expect(order.statusId).toBe(OrderStatusEnum.CONFIRMED);
      const events = order.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(OrderConfirmedEvent);
      const event = events[0] as OrderConfirmedEvent;
      expect(event.aggregateId).toBe(1);
      expect(event.lines).toEqual([
        { orderProductId: 1, productId: 10 },
        { orderProductId: 2, productId: 20 },
      ]);
    });

    it('does not flip the header or record an event when only some lines are confirmed', () => {
      const order = makeOrder([makeProduct(1), makeProduct(2)]);

      order.applyInventoryConfirmation([1]);

      expect(order.statusId).toBe(OrderStatusEnum.PENDING);
      expect(order.pullDomainEvents()).toHaveLength(0);
    });

    it('throws when the order is already CONFIRMED', () => {
      const order = makeOrder(
        [makeProduct(1, OrderProductStatusEnum.CONFIRMED)],
        OrderStatusEnum.CONFIRMED,
      );

      expect(() => order.applyInventoryConfirmation([])).toThrow(/already confirmed/);
    });

    it('returns newlyConfirmedProductIds in iteration order', () => {
      const order = makeOrder([makeProduct(1), makeProduct(2), makeProduct(3)]);

      const result = order.applyInventoryConfirmation([3, 1]);

      expect(result.newlyConfirmedProductIds).toEqual([1, 3]);
    });
  });
});
