import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, NotEquals } from 'class-validator';

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
