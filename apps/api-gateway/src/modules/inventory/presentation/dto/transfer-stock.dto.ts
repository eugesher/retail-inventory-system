import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

// Request body for `POST /api/inventory/variants/:variantId/stock/transfer`. The
// inventory domain has the final say (it re-validates the positive quantity, the
// distinct source/destination, both locations' existence/active state, and rejects
// an over-transfer with a 409); these decorators are the gateway's edge guard so a
// malformed request fails fast with a 400 before an RPC is dispatched. Both
// locations are REQUIRED — a transfer is intrinsically between two named locations,
// so neither defaults to the warehouse the way a receive/adjust target does.
export class TransferStockRequestDto {
  @ApiProperty({
    example: 'default-warehouse',
    description: 'Source stock location id (debited)',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  public fromLocationId: string;

  @ApiProperty({
    example: 'backup-store',
    description: 'Destination stock location id (credited)',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  public toLocationId: string;

  @ApiProperty({
    example: 5,
    description: 'Positive whole number of units to move from source to destination',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  public quantity: number;
}
