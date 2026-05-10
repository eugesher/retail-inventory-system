import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { OrderCreateDto, OrderCreateResponseDto } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IRetailGatewayPort, RETAIL_GATEWAY_PORT } from '../ports';

@Injectable()
export class CreateOrderUseCase {
  constructor(
    @Inject(RETAIL_GATEWAY_PORT)
    private readonly retailGateway: IRetailGatewayPort,
    @InjectPinoLogger(CreateOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    dto: OrderCreateDto,
    correlationId: string,
  ): Promise<OrderCreateResponseDto> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { customerId: dto.customerId, productCount: dto.products.length },
        'Order creation in progress',
      );

      const order = await this.retailGateway.createOrder(dto, correlationId);

      this.logger.info(
        { orderId: order.orderId, status: order.status },
        'Order successfully created',
      );

      return order;
    } catch (error) {
      this.logger.error(error, 'Error creating order');

      throwRpcError(error);
    }
  }
}
