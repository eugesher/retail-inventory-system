import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { MicroserviceMessagePatternEnum } from '@retail-inventory-system/common';
import {
  IOrderConfirm,
  IOrderCreatePayload,
  OrderConfirmResponseDto,
  OrderResponseDto,
} from '@retail-inventory-system/retail';
import { Order } from '../../common/entities';
import { OrderConfirmPipe, OrderCreatePipe } from './pipes';
import { OrderConfirmService, OrderCreateService, OrderGetService } from './providers';

@Controller()
export class OrderController {
  constructor(
    private readonly orderCreateService: OrderCreateService,
    private readonly orderConfirmService: OrderConfirmService,
    private readonly orderGetService: OrderGetService,
  ) {}

  @MessagePattern(MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE)
  public async create(
    @Payload(OrderCreatePipe) payload: IOrderCreatePayload,
  ): Promise<OrderResponseDto> {
    const { correlationId, ...data } = payload;

    Logger.log(
      { message: 'Order confirmation processing has begun on the inventory side', data },
      correlationId,
    ); // TODO: RIS-20 Replace with pino

    return await this.orderCreateService.execute(payload);
  }

  @MessagePattern(MicroserviceMessagePatternEnum.RETAIL_ORDER_CONFIRM)
  public async confirm(
    @Payload(OrderConfirmPipe) order: IOrderConfirm,
  ): Promise<OrderConfirmResponseDto> {
    const { correlationId, ...data } = order;

    Logger.log(
      { message: 'Order confirmation processing has begun on the inventory side', data },
      correlationId,
    ); // TODO: RIS-20 Replace with pino

    return await this.orderConfirmService.execute(order);
  }

  @MessagePattern(MicroserviceMessagePatternEnum.RETAIL_ORDER_GET)
  public async getById(@Payload() id: number): Promise<Order | null> {
    // TODO: RIS-20 Propagate correlationId into `apps/api-gateway/src/app/api/order/pipes/order-confirm.pipe.ts`

    return await this.orderGetService.findById(id);
  }
}
