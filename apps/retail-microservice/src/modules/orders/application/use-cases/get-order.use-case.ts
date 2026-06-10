import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailOrderGetPayload, OrderView } from '@retail-inventory-system/contracts';

import { OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import {
  IOrderRepositoryPort,
  IPaymentRepositoryPort,
  ORDER_REPOSITORY,
  PAYMENT_REPOSITORY,
} from '../ports';
import { toOrderView } from './order-view.factory';

// Get Order: resolves one order (header + lines + payment) by id for the read path
// (ADR-028 §7). Authorization is **owner-or-staff**, enforced here in the retail use
// case — the single point of truth:
//
// - allow if `canReadAny` (the gateway already confirmed the caller carries the staff
//   `order:read` permission), **or**
// - allow if `order.customerId === actorId` (the owning customer), **else** reject
//   `ORDER_ACCESS_FORBIDDEN` (403).
//
// A permission code is a **staff override layered over the owner-check, not a customer
// gate** (ADR-024): a customer carries no permissions, so it can only ever reach its
// own order, while staff with `order:read` can read any. A missing order is a 404.
@Injectable()
export class GetOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @InjectPinoLogger(GetOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailOrderGetPayload): Promise<OrderView> {
    const { orderId, actorId, canReadAny, correlationId } = payload;

    this.logger.info({ correlationId, orderId, actorId, canReadAny }, 'Fetching order');

    const order = await this.orderRepository.findById(orderId);
    if (!order) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_FOUND,
        `Order ${orderId} not found`,
      );
    }

    // Owner-or-staff authorization (ADR-028 §7). A non-staff caller may read only its
    // own order; staff with `order:read` may read any.
    if (!canReadAny && order.customerId !== actorId) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN,
        `Order ${orderId} is not accessible to actor ${actorId}`,
      );
    }

    const payment = await this.paymentRepository.findByOrderId(orderId);
    return toOrderView(order, payment);
  }
}
