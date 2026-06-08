import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, NotEquals } from 'class-validator';

// Request body for `POST /api/inventory/variants/:variantId/stock/adjust`. The
// inventory domain has the final say (it re-validates the non-zero delta, the
// mandatory reason, the location, and rejects a below-zero result with a 409);
// these decorators are the gateway's edge guard so a malformed request fails fast
// with a 400 before an RPC is dispatched.
export class AdjustStockRequestDto {
  @ApiPropertyOptional({
    example: 'default-warehouse',
    description: 'Target stock location id; omit to target the default warehouse',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public stockLocationId?: string;

  @ApiProperty({
    example: -3,
    description: 'Signed, non-zero whole number to add to (or subtract from) on-hand',
  })
  @IsInt()
  @NotEquals(0)
  public quantityDelta: number;

  @ApiProperty({
    example: 'damaged',
    description: 'Mandatory audit reason for the adjustment (carried on the event + logs)',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  public reasonCode: string;
}
