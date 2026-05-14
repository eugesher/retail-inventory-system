import { OrderStatusEnum } from '@retail-inventory-system/contracts';

import { CustomerRef, Order as OrderDomain, OrderStatusVO } from '../../domain';
import { Order as OrderEntity } from './order.entity';
import { OrderProductMapper } from './order-product.mapper';

const statusFor = (statusId: OrderStatusEnum): OrderStatusVO =>
  statusId === OrderStatusEnum.CONFIRMED ? OrderStatusVO.CONFIRMED : OrderStatusVO.PENDING;

export class OrderMapper {
  public static toDomain(entity: OrderEntity): OrderDomain {
    return OrderDomain.reconstitute({
      id: entity.id,
      customer: new CustomerRef({ id: entity.customerId }),
      products: (entity.products ?? []).map((p) => OrderProductMapper.toDomain(p)),
      status: statusFor(entity.statusId),
    });
  }
}
