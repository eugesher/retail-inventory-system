import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiProduces,
} from '@nestjs/swagger';

import { OrderCreateDto, OrderCreateResponseDto } from '@retail-inventory-system/retail';
import { OrderCreateService } from './providers';

@ApiTags('Order')
@Controller('orders')
export class OrderController {
  constructor(private readonly orderCreateService: OrderCreateService) {}

  @ApiOperation({
    summary: 'Create a new order',
  })
  @ApiCreatedResponse({
    description: 'Order created successfully',
    type: OrderCreateResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid input or stock issues',
  })
  @ApiProduces('application/json')
  @Post()
  public async createOrder(@Body() dto: OrderCreateDto): Promise<OrderCreateResponseDto> {
    return this.orderCreateService.execute(dto);
  }
}
