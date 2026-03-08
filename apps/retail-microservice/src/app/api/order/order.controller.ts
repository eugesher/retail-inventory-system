import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { MicroserviceMessagePatternEnum } from '@retail-inventory-system/common';
import { OrderCreateDto, OrderResponseDto } from '@retail-inventory-system/retail';
import { OrderConfirmService, OrderCreateService } from './providers';

@Controller()
export class OrderController {
  constructor(
    private readonly orderCreateService: OrderCreateService,
    private readonly orderConfirmService: OrderConfirmService,
  ) {}

  @MessagePattern(MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE)
  public async create(@Payload() data: OrderCreateDto): Promise<OrderResponseDto> {
    return await this.orderCreateService.execute(data);
  }

  @MessagePattern(MicroserviceMessagePatternEnum.RETAIL_ORDER_CONFIRM)
  public async confirm(@Payload() id: number): Promise<OrderResponseDto> {
    return await this.orderConfirmService.execute(id);
  }
}
