import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

// Request body for `POST /api/inventory/variants/:variantId/stock/receive`. The
// inventory domain has the final say (it re-validates the positive quantity and
// the location's existence/active state); these decorators are the gateway's edge
// guard so a malformed request fails fast with a 400 before an RPC is dispatched.
export class ReceiveStockRequestDto {
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
    example: 50,
    description: 'Positive whole number of units to add to on-hand',
  })
  @IsInt()
  @IsPositive()
  public quantity: number;
}
