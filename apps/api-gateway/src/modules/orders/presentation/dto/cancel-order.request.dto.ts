import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

// Request body for `POST /api/orders/:orderId/cancel`. `reason` is an optional
// human-supplied cancellation note — it rides the `retail.order.cancelled` event and
// the allocation-release movement on the retail side, but never changes a money total.
// The body may be omitted entirely (an empty `{}` cancels with no reason).
export class CancelOrderRequestDto {
  @ApiPropertyOptional({
    example: 'Customer changed their mind',
    description: 'Optional human-readable cancellation reason',
  })
  @IsOptional()
  @IsString()
  public reason?: string;
}
