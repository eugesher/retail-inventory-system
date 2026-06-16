import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

// Request body for `POST /api/orders/:orderId/lines/:lineId/cancel`. `quantity` is
// optional — omit it to cancel **all** the line's remaining unshipped quantity; a
// supplied value must be a positive integer and is rejected by the retail use case if
// it exceeds the unshipped remainder (409 `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING`).
// The body may be omitted entirely (an empty `{}` cancels the full remainder).
export class CancelLineRequestDto {
  @ApiPropertyOptional({
    example: 1,
    minimum: 1,
    description: 'Units to cancel; defaults to all the line remaining unshipped quantity',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  public quantity?: number;
}
