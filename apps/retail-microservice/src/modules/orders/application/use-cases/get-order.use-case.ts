import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailOrderGetPayload, OrderView } from '@retail-inventory-system/contracts';

import {
  IOrderRepositoryPort,
  IPaymentRepositoryPort,
  ORDER_REPOSITORY,
  PAYMENT_REPOSITORY,
} from '../ports';
import { loadAuthorizedOrder } from './order-access';
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

    // Owner-or-staff authorization (ADR-028 §7): a customer may read only its own
    // order; staff with `order:read` (folded into `canReadAny`) may read any. A
    // missing order is a 404, a non-owner-non-staff caller a 403.
    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, canReadAny);

    const payment = await this.paymentRepository.findByOrderId(orderId);
    return toOrderView(order, payment);
  }
}
