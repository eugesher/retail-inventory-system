import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

// Query string for `GET /api/catalog/products`. `page`/`pageSize` arrive as
// strings and are coerced via `@Type(() => Number)` (the global `ValidationPipe`
// runs with `transform: true`). The upper page-size cap is owned by the
// downstream `ListProductsUseCase` (it caps at 100), so the gateway only
// enforces the positive-integer floor here. `status` defaults to `active` on the
// read path — browse hides non-active products (ADR-025).
export class ListProductsQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'draft', 'archived'], example: 'active' })
  @IsOptional()
  @IsIn(['active', 'draft', 'archived'])
  public status?: 'active' | 'draft' | 'archived';

  @ApiPropertyOptional({ example: 1, minimum: 1, description: '1-based page index' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({ example: 20, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public pageSize?: number;

  @ApiPropertyOptional({ example: 'chair', description: 'Free-text name/slug filter' })
  @IsOptional()
  @IsString()
  public search?: string;
}
