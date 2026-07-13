import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailRefundListPayload, RefundView } from '@retail-inventory-system/contracts';

import { OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import {
  IOrderRepositoryPort,
  IRefundRepositoryPort,
  ORDER_REPOSITORY,
  REFUND_REPOSITORY,
} from '../ports';
import { toRefundView } from './refund-view.factory';

// List Refunds resolves an order's refund history newest-first (ADR-032). It is the
// read sibling of Issue Refund — the order-scoped refund timeline an operator or the
// owning customer inspects.
//
// Owner-or-staff on `order:read`, but **this one does NOT go through `loadAuthorizedOrder`** — it
// owner-checks inline so it can raise `REFUND_ACCESS_FORBIDDEN` rather than the order's code, giving
// the refund surface its own messaging. The check itself is the same one, and so is the answer.
//
// **A non-owner is REFUSED (403), not filtered** — the rule for every order-scoped list, now written
// down (ADR-051). `list-returns` used to take the opposite posture on the same shape of request and
// hand back an empty list; it no longer does.
@Injectable()
export class ListRefundsForOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(REFUND_REPOSITORY)
    private readonly refundRepository: IRefundRepositoryPort,
    @InjectPinoLogger(ListRefundsForOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailRefundListPayload): Promise<RefundView[]> {
    const { orderId, actorId, isStaff, correlationId } = payload;

    this.logger.info({ correlationId, orderId, actorId, isStaff }, 'Listing order refunds');

    const order = await this.orderRepository.findById(orderId);
    if (!order) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_FOUND,
        `Order ${orderId} not found`,
      );
    }
    if (!isStaff && order.customerId !== actorId) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.REFUND_ACCESS_FORBIDDEN,
        `Refunds for order ${orderId} are not accessible to actor ${actorId}`,
      );
    }

    const refunds = await this.refundRepository.findByOrderId(orderId);
    return refunds.map((refund) => toRefundView(refund));
  }
}
