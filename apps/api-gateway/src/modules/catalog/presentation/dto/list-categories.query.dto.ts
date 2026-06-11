import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

import { parseBooleanQuery } from './validation.constants';

// Query string for `GET /api/catalog/categories`. The single optional `?root`
// flag narrows the flat list to top-level categories only (`parentId IS NULL`).
// `parseBooleanQuery` normalizes its string form to a real boolean at the edge
// (an absent value collapses to `undefined`, which the use case defaults off —
// every category); see the helper for the full token mapping.
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
