import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

// Query string for `GET /api/orders`. `page`/`pageSize` arrive as strings and are
// coerced via `@Type(() => Number)` (the global `ValidationPipe` runs with
// `transform: true`). The upper page-size ceiling is owned by the downstream
// `ListMyOrdersUseCase` (it caps at 100), so the gateway only enforces the
// positive-integer floor here; both default at the edge (`page`→1, `pageSize`→20).
export class ListOrdersQueryDto {
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
}
