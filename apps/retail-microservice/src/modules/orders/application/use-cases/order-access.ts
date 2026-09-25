import { Order, OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import { IOrderRepositoryPort } from '../ports';

export async function loadAuthorizedOrder(
  repository: IOrderRepositoryPort,
  orderId: number,
  actorId: string,
  staffOverride: boolean,
): Promise<Order> {
  const order = await repository.findById(orderId);
  if (order === null) {
    throw new OrderDomainException(
      OrderErrorCodeEnum.ORDER_NOT_FOUND,
      `Order ${orderId} not found`,
    );
  }
  if (!staffOverride && order.customerId !== actorId) {
    throw new OrderDomainException(
      OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN,
      `Order ${orderId} is not accessible to actor ${actorId}`,
    );
  }
  return order;
}
