import { OrderProductStatusEnum, OrderStatusEnum } from '@retail-inventory-system/contracts';

import { Order } from '..';

describe('Order.create', () => {
  it('expands per-quantity into one line per unit (matches the legacy invariant)', () => {
    const order = Order.create({
      lines: [
        { productId: 1, quantity: 2 },
        { productId: 2, quantity: 1 },
      ],
    });

    expect(order.statusId).toBe(OrderStatusEnum.PENDING);
    expect(order.products).toHaveLength(3);
    expect(order.products.map((p) => p.productId)).toEqual([1, 1, 2]);
    expect(order.products.every((p) => p.statusId === OrderProductStatusEnum.PENDING)).toBe(true);
    expect(order.products.every((p) => p.id === null)).toBe(true);
    expect(order.id).toBeNull();
  });

  it('rejects an empty lines array', () => {
    expect(() => Order.create({ lines: [] })).toThrow(/no line items/);
  });

  it('rejects non-positive quantities', () => {
    expect(() => Order.create({ lines: [{ productId: 1, quantity: 0 }] })).toThrow(
      /positive integer/,
    );
  });

  it('does not record an OrderCreated event from the factory (use case publishes post-save)', () => {
    const order = Order.create({ lines: [{ productId: 1, quantity: 1 }] });

    expect(order.pullDomainEvents()).toHaveLength(0);
  });
});
