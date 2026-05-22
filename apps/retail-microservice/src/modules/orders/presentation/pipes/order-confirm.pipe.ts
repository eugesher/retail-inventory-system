import { HttpStatus, Inject, Injectable, PipeTransform } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IOrderConfirm, IOrderConfirmPayload } from '@retail-inventory-system/contracts';

import { IOrderRepositoryPort, ORDER_REPOSITORY } from '../../application/ports';

@Injectable()
export class OrderConfirmPipe implements PipeTransform<
  IOrderConfirmPayload,
  Promise<IOrderConfirm>
> {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @InjectPinoLogger(OrderConfirmPipe.name)
    private readonly logger: PinoLogger,
  ) {}

  public async transform(payload: IOrderConfirmPayload): Promise<IOrderConfirm> {
    const { id, correlationId } = payload;

    const order = await this.orderRepository.findConfirmableOrder(id);

    if (!order) {
      this.logger.warn(
        { correlationId, orderId: id },
        'Order not found, rejecting confirm request',
      );
      throw new RpcException({
        statusCode: HttpStatus.NOT_FOUND,
        message: `Order #${id} not found`,
      });
    }

    return { ...order, correlationId };
  }
}
