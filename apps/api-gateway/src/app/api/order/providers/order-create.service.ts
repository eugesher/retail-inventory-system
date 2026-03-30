import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import {
  IOrderCreatePayload,
  OrderCreateDto,
  OrderCreateResponseDto,
} from '@retail-inventory-system/retail';
import { throwRpcError } from '../../../common/rpc-error.util';

@Injectable()
export class OrderCreateService {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailMicroserviceClient: ClientProxy,
    @InjectPinoLogger(OrderCreateService.name)
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
      this.logger.info(
        { pattern: MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE },
        'Sending RPC to retail service',
      );

      const order = await firstValueFrom(
        this.retailMicroserviceClient.send<OrderCreateResponseDto, IOrderCreatePayload>(
          MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE,
          { ...dto, correlationId },
        ),
      );

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
