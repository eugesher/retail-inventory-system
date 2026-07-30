import { Order, OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import { IOrderRepositoryPort } from '../ports';

// **The one gate. Every use case that touches an order by id comes through here** — read, capture,
// ship, deliver, cancel, fulfil, list. If a new one does not, the module has grown a second
// authorization model without deciding to.
//
// **The rule (ADR-028 §7), stated once so nothing else has to restate it:** a customer is
// authorized by *authentication plus ownership*, never by a permission code — customer tokens carry
// no `permissions` claim at all (ADR-024), so a `@RequiresPermission('customer:…')` gate would
// reject the very customers it was written to admit. **`staffOverride` is a staff grant layered over
// the owner-check, never a customer gate.** The gateway has already confirmed it; retail only reads
// the resolved boolean, and re-asserts ownership itself rather than trusting the edge.
//
// A missing order is `ORDER_NOT_FOUND`; a non-owner without the override is `ORDER_ACCESS_FORBIDDEN`.
// **The two are deliberately distinguishable** — this surface confirms that an order exists to a
// caller who may not read it.
//
// **That is the repository-wide answer, and it is written down now (ADR-051): a non-owner is refused
// with a 403, never handed a filtered empty list.** `list-returns` used to dissent and filter; it no
// longer does. The no-existence-leak posture the filter was reaching for is not available here
// anyway — order-id existence is already confirmable by enumeration on the mutation routes, and a
// mutation cannot be filtered. Adopting it honestly would mean turning every non-owner refusal in
// retail into a 404. `test/order-scoped-list-refusal.e2e-spec.ts` pins all three order-scoped lists
// to the same answer.
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
