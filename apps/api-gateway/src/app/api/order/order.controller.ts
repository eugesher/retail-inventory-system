import { Body, Controller, Inject, Param, Post, Put } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiProduces,
  ApiOkResponse,
} from '@nestjs/swagger';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { OrderCreateDto, OrderResponseDto } from '@retail-inventory-system/retail';

@ApiTags('Order')
@Controller('orders')
export class OrderController {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailMicroserviceClient: ClientProxy,
  ) {}

  @ApiOperation({
    summary: 'Create a new order',
  })
  @ApiCreatedResponse({
    description: 'Order created successfully',
    type: OrderResponseDto,
  })
  @ApiProduces('application/json')
  @Post()
  public async createOrder(@Body() dto: OrderCreateDto): Promise<OrderResponseDto> {
    return await firstValueFrom(
      this.retailMicroserviceClient.send<OrderResponseDto, OrderCreateDto>(
        MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE,
        dto,
      ),
    );
  }

  @ApiOperation({
    summary: 'Confirm order',
  })
  @ApiOkResponse({
    description: 'Order successfully confirmed',
    type: OrderResponseDto,
  })
  @ApiProduces('application/json')
  @Put(':id/confirm')
  public async confirmOrder(@Param('id') id: number): Promise<OrderResponseDto> {
    return await firstValueFrom(
      this.retailMicroserviceClient.send<OrderResponseDto, number>(
        MicroserviceMessagePatternEnum.RETAIL_ORDER_CONFIRM,
        id,
      ),
    );
  }
}
