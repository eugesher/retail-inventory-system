import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { MicroserviceMessagePatternEnum } from '@retail-inventory-system/common';
import { OrderCreateDto, OrderCreateResponseDto } from '@retail-inventory-system/retail';
import { OrderCreateService } from './providers';

@Controller()
export class OrderController {
  constructor(private readonly orderCreateService: OrderCreateService) {}

  @MessagePattern(MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE)
  public async create(@Payload() data: OrderCreateDto): Promise<OrderCreateResponseDto> {
    return this.orderCreateService.execute(data);
  }
}
