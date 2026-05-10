import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IOrderConfirmPayload,
  IOrderCreatePayload,
  OrderConfirmResponseDto,
  OrderCreateDto,
  OrderCreateResponseDto,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IRetailGatewayPort } from '../../application/ports';

@Injectable()
export class RetailRabbitmqAdapter implements IRetailGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async createOrder(
    dto: OrderCreateDto,
    correlationId: string,
  ): Promise<OrderCreateResponseDto> {
    return firstValueFrom(
      this.client.send<OrderCreateResponseDto, IOrderCreatePayload>(
        ROUTING_KEYS.RETAIL_ORDER_CREATE,
        { ...dto, correlationId },
      ),
    );
  }

  public async confirmOrder(id: number, correlationId: string): Promise<OrderConfirmResponseDto> {
    return firstValueFrom(
      this.client.send<OrderConfirmResponseDto, IOrderConfirmPayload>(
        ROUTING_KEYS.RETAIL_ORDER_CONFIRM,
        { id, correlationId },
      ),
    );
  }

  public async getOrderStatus(id: number): Promise<{ statusId: OrderStatusEnum } | null> {
    return firstValueFrom(
      this.client.send<{ statusId: OrderStatusEnum } | null, number>(
        ROUTING_KEYS.RETAIL_ORDER_GET,
        id,
      ),
    );
  }
}
