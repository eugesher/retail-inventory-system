import { ApiResponseProperty } from '@nestjs/swagger';

import { OrderProductStatusEnum, OrderStatusEnum } from '../enums';

class OrderConfirmProductStatusResponseDto {
  @ApiResponseProperty()
  public id: OrderProductStatusEnum;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public color: string;
}

class OrderConfirmProductResponseDto {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public productId: number;

  @ApiResponseProperty({ type: OrderConfirmProductStatusResponseDto })
  public status: OrderConfirmProductStatusResponseDto;
}

class OrderConfirmStatusResponseDto {
  @ApiResponseProperty()
  public id: OrderStatusEnum;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public color: string;
}

export class OrderConfirmResponseDto {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty({ type: OrderConfirmStatusResponseDto })
  public status: OrderConfirmStatusResponseDto;

  @ApiResponseProperty({ type: [OrderConfirmProductResponseDto] })
  public products: OrderConfirmProductResponseDto[];
}
