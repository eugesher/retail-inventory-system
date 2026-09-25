import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';

export class MovementsQueryDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, description: '1-based page index' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({
    example: 20,
    minimum: 1,
    maximum: 100,
    description: 'Page size (max 100)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public pageSize?: number;

  @ApiPropertyOptional({
    enum: StockMovementTypeEnum,
    description:
      'Filter to one movement type (receipt / adjustment / allocation / sale / release / return)',
  })
  @IsOptional()
  @IsEnum(StockMovementTypeEnum)
  public type?: StockMovementTypeEnum;

  @ApiPropertyOptional({
    example: '2026-06-01T00:00:00.000Z',
    description: 'Inclusive lower bound on occurredAt (ISO-8601)',
  })
  @IsOptional()
  @IsISO8601()
  public from?: string;

  @ApiPropertyOptional({
    example: '2026-06-30T23:59:59.999Z',
    description: 'Inclusive upper bound on occurredAt (ISO-8601)',
  })
  @IsOptional()
  @IsISO8601()
  public to?: string;
}
