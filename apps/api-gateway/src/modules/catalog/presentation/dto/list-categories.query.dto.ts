import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

import { parseBooleanQuery } from './validation.constants';

export class ListCategoriesQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    example: true,
    description: 'Keep only top-level (root) categories when true; omit for every category',
  })
  @Transform(({ value }) => parseBooleanQuery(value))
  @IsOptional()
  @IsBoolean()
  public root?: boolean;
}
