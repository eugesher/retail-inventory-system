import { OrderProductStatusEnum } from '@retail-inventory-system/contracts';

import { OrderProduct as OrderProductDomain, OrderProductStatusVO } from '../../domain';
import { OrderProduct as OrderProductEntity } from './order-product.entity';

const statusFor = (statusId: OrderProductStatusEnum): OrderProductStatusVO =>
  statusId === OrderProductStatusEnum.CONFIRMED
    ? OrderProductStatusVO.CONFIRMED
    : OrderProductStatusVO.PENDING;

export class OrderProductMapper {
  public static toDomain(entity: OrderProductEntity): OrderProductDomain {
    return new OrderProductDomain({
      id: entity.id,
      productId: entity.productId,
      status: statusFor(entity.statusId),
    });
  }
}
