import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';

// Query string for `GET /api/inventory/variants/:variantId/movements` — the audit
// read of a variant's `stock_movement` ledger. Every parameter is optional.
//
// `page` / `pageSize` arrive as strings and are coerced via `@Type(() => Number)`
// (the global `ValidationPipe` runs with `transform: true`); the controller
// defaults them at the edge (`page`→1, `pageSize`→20) and maps `pageSize` onto the
// RPC payload's `size` (the orders-list `?page/?pageSize` precedent). Unlike the
// orders list, the page-size ceiling is enforced **here** with `@Max(100)` — the
// inventory audit use case does not cap, so the gateway DTO is the guard.
//
// `type` narrows to one movement kind; `from` / `to` are ISO-8601 instants that
// bound `occurredAt` inclusively. The `@IsISO8601()` validators are the gate that
// lets the downstream use case treat any value that reaches it as well-formed.
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
