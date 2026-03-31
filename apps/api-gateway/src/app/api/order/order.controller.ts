import { Body, Controller, Param, Post, Put } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiProduces,
  ApiOkResponse,
} from '@nestjs/swagger';

import { CorrelationId } from '@retail-inventory-system/common';
import {
  OrderConfirmResponseDto,
  OrderCreateDto,
  OrderCreateResponseDto,
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
  @ApiCreatedResponse({ description: 'Order successfully created', type: OrderCreateResponseDto })
  @ApiProduces('application/json')
  @Post()
  public async createOrder(
    @Body() dto: OrderCreateDto,
    @CorrelationId() correlationId: string,
  ): Promise<OrderCreateResponseDto> {
    return this.orderCreateService.execute(dto, correlationId);
  }

  @ApiOperation({ summary: 'Confirm order' })
  @ApiOkResponse({ description: 'Order successfully confirmed', type: OrderConfirmResponseDto })
  @ApiProduces('application/json')
  @Put(':id/confirm')
  public async confirmOrder(
    @Param('id', OrderConfirmPipe) id: number,
    @CorrelationId() correlationId: string,
  ): Promise<OrderConfirmResponseDto> {
    return this.orderConfirmService.execute(id, correlationId);
  }
}
