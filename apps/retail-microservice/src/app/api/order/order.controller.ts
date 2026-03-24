import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { MicroserviceMessagePatternEnum } from '@retail-inventory-system/common';
import {
  OrderConfirmResponseDto,
  OrderCreateDto,
  OrderResponseDto,
} from '@retail-inventory-system/retail';
import { Order } from '../../common/entities';
import { OrderCreatePipe } from './pipes';
import { OrderConfirmService, OrderCreateService, OrderGetService } from './providers';

@Controller()
export class OrderController {
  constructor(
    private readonly orderCreateService: OrderCreateService,
    private readonly orderConfirmService: OrderConfirmService,
    private readonly orderGetService: OrderGetService,
  ) {}

  @MessagePattern(MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE)
  public async create(@Payload(OrderCreatePipe) data: OrderCreateDto): Promise<OrderResponseDto> {
    return await this.orderCreateService.execute(data);
  }

  @MessagePattern(MicroserviceMessagePatternEnum.RETAIL_ORDER_CONFIRM)
  public async confirm(@Payload() id: number): Promise<OrderConfirmResponseDto> {
    return await this.orderConfirmService.execute(id);
  }

  @MessagePattern(MicroserviceMessagePatternEnum.RETAIL_ORDER_GET)
  public async getById(@Payload() id: number): Promise<Order | null> {
    return await this.orderGetService.findById(id);
  }
}
