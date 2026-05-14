import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  IOrderConfirm,
  IOrderCreatePayload,
  OrderConfirmResponseDto,
  OrderCreateResponseDto,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { ConfirmOrderUseCase, CreateOrderUseCase, GetOrderUseCase } from '../application/use-cases';
import { OrderConfirmPipe, OrderCreatePipe } from './pipes';

@Controller()
export class OrderController {
  constructor(
    private readonly createOrderUseCase: CreateOrderUseCase,
    private readonly confirmOrderUseCase: ConfirmOrderUseCase,
    private readonly getOrderUseCase: GetOrderUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.RETAIL_ORDER_CREATE)
  public async create(
    @Payload(OrderCreatePipe) payload: IOrderCreatePayload,
  ): Promise<OrderCreateResponseDto> {
    return this.createOrderUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_ORDER_CONFIRM)
  public async confirm(
    @Payload(OrderConfirmPipe) order: IOrderConfirm,
  ): Promise<OrderConfirmResponseDto> {
    return this.confirmOrderUseCase.execute(order);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_ORDER_GET)
  public async getById(@Payload() id: number): Promise<{ statusId: OrderStatusEnum } | null> {
    return this.getOrderUseCase.findHeaderById(id);
  }
}
