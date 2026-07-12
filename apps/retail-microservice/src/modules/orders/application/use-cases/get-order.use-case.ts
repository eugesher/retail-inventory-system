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

// Resolves one order — header, lines and payment — by id.
//
// Authorization goes through `loadAuthorizedOrder` (the rule is stated there, once); the override is
// `order:read`.
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

    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, canReadAny);

    const payment = await this.paymentRepository.findByOrderId(orderId);
    return toOrderView(order, payment);
  }
}
