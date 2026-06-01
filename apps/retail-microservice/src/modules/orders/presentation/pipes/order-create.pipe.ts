import { HttpStatus, Inject, Injectable, PipeTransform } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IOrderCreatePayload } from '@retail-inventory-system/contracts';

import { IOrderRepositoryPort, ORDER_REPOSITORY } from '../../application/ports';

@Injectable()
export class OrderCreatePipe implements PipeTransform<
  IOrderCreatePayload,
  Promise<IOrderCreatePayload>
> {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @InjectPinoLogger(OrderCreatePipe.name)
    private readonly logger: PinoLogger,
  ) {}

  public async transform(payload: IOrderCreatePayload): Promise<IOrderCreatePayload> {
    const { correlationId } = payload;
    const productIds = [...new Set(payload.products.map((p) => p.productId))];

    const foundProductIds = await this.orderRepository.findExistingProductIds(productIds);

    if (foundProductIds.length !== productIds.length) {
      this.logger.warn(
        { correlationId, productIds },
        'Invalid product IDs, rejecting order creation',
      );
      throw new RpcException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'One or more product IDs are invalid',
      });
    }

    return payload;
  }
}
