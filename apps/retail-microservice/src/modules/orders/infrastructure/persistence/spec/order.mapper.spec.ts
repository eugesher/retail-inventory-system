import { OrderProductStatusEnum, OrderStatusEnum } from '@retail-inventory-system/contracts';

import { Order as OrderEntity } from '../order.entity';
import { OrderProduct as OrderProductEntity } from '../order-product.entity';
import { OrderMapper } from '../order.mapper';

// Round-trip: entity → domain → entity-shaped projection back. We don't have
// a domain → entity mapper today (the typeorm repo builds a `DeepPartial`
// in-line via `save`), so the assertion is on the domain-side projection
// preserving every field used downstream.
describe('OrderMapper round-trip', () => {
  it('maps a persisted Order entity into a domain aggregate with line items and statuses', () => {
    const entity: OrderEntity = Object.assign(new OrderEntity(), {
      id: 42,
      customerId: 7,
      statusId: OrderStatusEnum.PENDING,
      products: [
        Object.assign(new OrderProductEntity(), {
          id: 421,
          orderId: 42,
          productId: 1,
          statusId: OrderProductStatusEnum.PENDING,
        }),
        Object.assign(new OrderProductEntity(), {
          id: 422,
          orderId: 42,
          productId: 2,
          statusId: OrderProductStatusEnum.CONFIRMED,
        }),
      ],
    });

    const domain = OrderMapper.toDomain(entity);

    expect(domain.id).toBe(42);
    expect(domain.customer.id).toBe(7);
    expect(domain.statusId).toBe(OrderStatusEnum.PENDING);
    expect(domain.products).toHaveLength(2);
    expect(domain.products[0].id).toBe(421);
    expect(domain.products[0].productId).toBe(1);
    expect(domain.products[0].statusId).toBe(OrderProductStatusEnum.PENDING);
    expect(domain.products[1].id).toBe(422);
    expect(domain.products[1].statusId).toBe(OrderProductStatusEnum.CONFIRMED);
  });

  it('maps a confirmed Order entity (preserves the CONFIRMED header)', () => {
    const entity: OrderEntity = Object.assign(new OrderEntity(), {
      id: 1,
      customerId: 1,
      statusId: OrderStatusEnum.CONFIRMED,
      products: [
        Object.assign(new OrderProductEntity(), {
          id: 11,
          orderId: 1,
          productId: 1,
          statusId: OrderProductStatusEnum.CONFIRMED,
        }),
      ],
    });

    const domain = OrderMapper.toDomain(entity);

    expect(domain.statusId).toBe(OrderStatusEnum.CONFIRMED);
    expect(domain.products[0].isConfirmed()).toBe(true);
  });
});
