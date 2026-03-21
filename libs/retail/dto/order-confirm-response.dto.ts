import { ApiResponseProperty } from '@nestjs/swagger';

class OrderStatusResponseDto {
  @ApiResponseProperty()
  public id: string;

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

  @ApiResponseProperty({ type: OrderStatusResponseDto })
  public status: OrderStatusResponseDto;
}

export class OrderConfirmResponseDto {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty({ type: OrderStatusResponseDto })
  public status: OrderStatusResponseDto;

  @ApiResponseProperty({ type: [OrderConfirmProductResponseDto] })
  public products: OrderConfirmProductResponseDto[];
}
