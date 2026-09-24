import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { FulfillmentView, IRetailFulfillmentListPayload } from '@retail-inventory-system/contracts';

import {
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepositoryPort,
  IOrderRepositoryPort,
  ORDER_REPOSITORY,
} from '../ports';
import { loadAuthorizedOrder } from './order-access';
import { toFulfillmentView } from './fulfillment-view.factory';

@Injectable()
export class ListFulfillmentsUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(FULFILLMENT_REPOSITORY)
    private readonly fulfillmentRepository: IFulfillmentRepositoryPort,
    @InjectPinoLogger(ListFulfillmentsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailFulfillmentListPayload): Promise<FulfillmentView[]> {
    const { orderId, actorId, canReadAny, correlationId } = payload;

    this.logger.info({ correlationId, orderId, actorId, canReadAny }, 'Listing fulfillments');

    await loadAuthorizedOrder(this.orderRepository, orderId, actorId, canReadAny);

    const fulfillments = await this.fulfillmentRepository.listByOrderId(orderId);
    return fulfillments.map((fulfillment) => toFulfillmentView(fulfillment));
  }
}
