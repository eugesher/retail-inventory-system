import { ApiResponseProperty } from '@nestjs/swagger';
import { OrderStatusEnum } from '../enums';

export class OrderCreateResponseDto {
  @ApiResponseProperty()
  public orderId: number;

  @ApiResponseProperty({ enum: OrderStatusEnum })
  public status: OrderStatusEnum;

  @ApiResponseProperty()
  public message: string;
}
