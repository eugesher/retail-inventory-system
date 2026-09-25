import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

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
