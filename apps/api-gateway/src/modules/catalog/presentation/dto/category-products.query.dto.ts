import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

import { parseBooleanQuery } from './validation.constants';

// Query string for `GET /api/catalog/categories/:slug/products`. The category is
// named by the `:slug` path param; this query carries the scope + pagination
// knobs. `includeDescendants` widens the read from the named category to the
// category PLUS its active subtree (every product in any descendant category) —
// a path-prefix expansion the use case computes (ADR-029). Like `?root` on the
// list route it is normalized from its string form to a real boolean at the edge
// via `parseBooleanQuery`.
//
// `page`/`pageSize` mirror `ListProductsQueryDto`'s coercion (`@Type(() => Number)`
// under the global `transform: true` pipe) and additionally **default at the
// edge** (`page`→1, `pageSize`→20) via field initializers, so the wire always
// carries a concrete page window; the downstream use case owns the upper cap.
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
