import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

import { parseBooleanQuery } from './validation.constants';

export class CategoryProductsQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    example: true,
    description: 'Include products in the active descendant subtree, not just the named category',
  })
  @Transform(({ value }) => parseBooleanQuery(value))
  @IsOptional()
  @IsBoolean()
  public includeDescendants?: boolean;

  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1, description: '1-based page index' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page = 1;

  @ApiPropertyOptional({ example: 20, minimum: 1, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public pageSize = 20;
}
