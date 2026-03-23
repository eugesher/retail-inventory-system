import { Body, Controller, Param, Post, Put } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiProduces,
  ApiOkResponse,
} from '@nestjs/swagger';

import {
  OrderConfirmResponseDto,
  OrderCreateDto,
  OrderResponseDto,
} from '@retail-inventory-system/retail';
import { OrderConfirmPipe } from './pipes';
import { OrderConfirmService, OrderCreateService } from './providers';

@ApiTags('Order')
@Controller('order')
export class OrderController {
  constructor(
    private readonly orderCreateService: OrderCreateService,
    private readonly orderConfirmService: OrderConfirmService,
  ) {}

  @ApiOperation({ summary: 'Create a new order' })
  @ApiCreatedResponse({ description: 'Order created successfully', type: OrderResponseDto })
  @ApiProduces('application/json')
  @Post()
  public async createOrder(@Body() dto: OrderCreateDto): Promise<OrderResponseDto> {
    return this.orderCreateService.execute(dto);
  }

  @ApiOperation({ summary: 'Confirm order' })
  @ApiOkResponse({ description: 'Order successfully confirmed', type: OrderConfirmResponseDto })
  @ApiProduces('application/json')
  @Put(':id/confirm')
  public async confirmOrder(
    @Param('id', OrderConfirmPipe) id: number,
  ): Promise<OrderConfirmResponseDto> {
    return this.orderConfirmService.execute(id);
  }
}
