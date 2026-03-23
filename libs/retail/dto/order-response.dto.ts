import { ApiResponseProperty } from '@nestjs/swagger';
import { OrderStatusEnum } from '../enums';

export class OrderResponseDto {
  @ApiResponseProperty()
  public orderId: number;

  @ApiResponseProperty({ enum: OrderStatusEnum })
  public status: OrderStatusEnum;

  @ApiResponseProperty()
  public message: string;
}
