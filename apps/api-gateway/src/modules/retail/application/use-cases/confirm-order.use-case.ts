import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { OrderConfirmResponseDto, OrderStatusEnum } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IRetailGatewayPort, RETAIL_GATEWAY_PORT } from '../ports';

@Injectable()
export class ConfirmOrderUseCase {
  constructor(
    @Inject(RETAIL_GATEWAY_PORT)
    private readonly retailGateway: IRetailGatewayPort,
    @InjectPinoLogger(ConfirmOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(id: number, correlationId: string): Promise<OrderConfirmResponseDto> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ orderId: id }, 'Order confirmation in progress');

      const order = await this.retailGateway.confirmOrder(id, correlationId);

      if (order.status.id !== OrderStatusEnum.CONFIRMED) {
        this.logger.warn({ orderId: id, statusId: order.status.id }, 'Order not fully confirmed');
      } else {
        this.logger.info(
          { orderId: id, statusId: order.status.id },
          'Order successfully confirmed',
        );
      }

      return order;
    } catch (error) {
      this.logger.error(error, 'Error confirming order');

      throwRpcError(error);
    }
  }
}
