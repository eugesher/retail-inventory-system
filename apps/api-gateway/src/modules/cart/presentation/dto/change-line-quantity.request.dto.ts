import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

// Request body for `PATCH /api/cart/:cartId/lines/:lineId`. A `0` is rejected
// (minimum 1) — removal is the explicit `DELETE` op, both here at the edge and in
// the cart domain (`CART_LINE_QUANTITY_INVALID`).
export class ChangeLineQuantityRequestDto {
  @ApiProperty({ example: 1, minimum: 1, description: 'New line quantity (must be positive)' })
  @IsInt()
  @Min(1)
  public quantity: number;
}
