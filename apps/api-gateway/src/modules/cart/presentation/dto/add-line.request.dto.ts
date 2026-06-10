import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

// Request body for `POST /api/cart/:cartId/lines`. The price is never sent by the
// caller — it is snapshotted retail-side from `catalog.price.select`. `variantId`
// is the opaque catalog variant key; the cart domain re-validates positivity.
export class AddLineRequestDto {
  @ApiProperty({ example: 1, minimum: 1, description: 'Catalog variant id' })
  @IsInt()
  @Min(1)
  public variantId: number;

  @ApiProperty({ example: 2, minimum: 1, description: 'Units to add' })
  @IsInt()
  @Min(1)
  public quantity: number;
}
