import { Body, Controller, Param, Post, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';

import { RoleEnum, Roles } from '@retail-inventory-system/auth';
import {
  OrderConfirmResponseDto,
  OrderCreateDto,
  OrderCreateResponseDto,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import { ConfirmOrderUseCase, CreateOrderUseCase } from '../application/use-cases';
import { OrderConfirmPipe } from './pipes';

@ApiTags('Order')
@ApiBearerAuth()
@Roles(RoleEnum.ADMIN)
@Controller('order')
export class OrderController {
  constructor(
    private readonly createOrderUseCase: CreateOrderUseCase,
    private readonly confirmOrderUseCase: ConfirmOrderUseCase,
  ) {}

  @ApiOperation({ summary: 'Create a new order' })
  @ApiCreatedResponse({ description: 'Order successfully created', type: OrderCreateResponseDto })
  @ApiProduces('application/json')
  @Post()
  public async createOrder(
    @Body() dto: OrderCreateDto,
    @CorrelationId() correlationId: string,
  ): Promise<OrderCreateResponseDto> {
    return this.createOrderUseCase.execute(dto, correlationId);
  }

  @ApiOperation({ summary: 'Confirm order' })
  @ApiOkResponse({ description: 'Order successfully confirmed', type: OrderConfirmResponseDto })
  @ApiProduces('application/json')
  @Put(':id/confirm')
  public async confirmOrder(
    @Param('id', OrderConfirmPipe) id: number,
    @CorrelationId() correlationId: string,
  ): Promise<OrderConfirmResponseDto> {
    return this.confirmOrderUseCase.execute(id, correlationId);
  }
}
