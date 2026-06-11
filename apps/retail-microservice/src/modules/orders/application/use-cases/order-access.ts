import { Order, OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import { IOrderRepositoryPort } from '../ports';

// Loads an order and asserts the caller may see it — the retail-side half of the
// bearer-plus-owner-or-staff model (ADR-028 §7), shared by the order read + capture
// use cases so the not-found + authorization rule lives in exactly one place (the
// cart context's `loadOwnedCart` precedent). `staffOverride` is the per-operation
// staff grant the gateway already confirmed (`order:read` for the read path,
// `order:capture` for capture): a staff caller may reach any order, a customer only
// its own. A permission code is a staff override layered over the owner-check, never
// a customer gate (ADR-024).
//
// A missing order is a 404 (`ORDER_NOT_FOUND`); a non-owner-non-staff caller is a 403
// (`ORDER_ACCESS_FORBIDDEN`) — both surface through the orders RPC exception filter.
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
