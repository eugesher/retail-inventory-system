import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailReturnListPayload, ReturnRequestView } from '@retail-inventory-system/contracts';

import { ReturnDomainException, ReturnErrorCodeEnum } from '../../domain';
import {
  IReturnOrderReaderPort,
  IReturnRequestRepositoryPort,
  RETURN_ORDER_READER,
  RETURN_REQUEST_REPOSITORY,
} from '../ports';
import { toReturnRequestView } from './return-view.factory';

@Injectable()
export class ListReturnsForOrderUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURN_ORDER_READER)
    private readonly orderReader: IReturnOrderReaderPort,
    @InjectPinoLogger(ListReturnsForOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnListPayload): Promise<ReturnRequestView[]> {
    const { orderId, actorId, isStaff, correlationId } = payload;

    this.logger.info({ correlationId, orderId, actorId, isStaff }, 'Listing returns for order');

    const order = await this.orderReader.findOrderForReturn(orderId);
    if (order === null) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_ORDER_NOT_FOUND,
        `Order ${orderId} not found`,
      );
    }
    if (!isStaff && order.customerId !== actorId) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN,
        `Returns for order ${orderId} are not accessible to actor ${actorId}`,
      );
    }

    const requests = await this.repository.listByOrderId(orderId);
    return requests.map((request) => toReturnRequestView(request));
  }
}
