import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import {
  IOrderConfirmPayload,
  OrderConfirmResponseDto,
  OrderStatusEnum,
} from '@retail-inventory-system/retail';
import { throwRpcError } from '../../../common/utils';

@Injectable()
export class OrderConfirmService {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailMicroserviceClient: ClientProxy,
    @InjectPinoLogger(OrderConfirmService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(id: number, correlationId: string): Promise<OrderConfirmResponseDto> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ orderId: id }, 'Order confirmation in progress');
      this.logger.info(
        { pattern: MicroserviceMessagePatternEnum.RETAIL_ORDER_CONFIRM },
        'Sending RPC to retail service',
      );

      const order = await firstValueFrom(
        this.retailMicroserviceClient.send<OrderConfirmResponseDto, IOrderConfirmPayload>(
          MicroserviceMessagePatternEnum.RETAIL_ORDER_CONFIRM,
          { id, correlationId },
        ),
      );

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
