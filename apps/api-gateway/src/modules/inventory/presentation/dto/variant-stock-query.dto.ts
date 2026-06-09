import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsString } from 'class-validator';

// Query string for `GET /api/inventory/variants/:variantId/stock`. The single
// optional `?locationIds` parameter scopes the availability answer to a subset of
// stock locations. **Encoding: comma-separated** — `?locationIds=default-warehouse,backup-store`
// — chosen over a JSON-encoded array string for a friendlier, copy-pasteable URL.
//
// `@Transform` normalizes the raw value into a clean `string[]` and is tolerant of
// the repeated-param form too (`?locationIds=a&locationIds=b`, which Express's `qs`
// parser delivers as an array): it splits every token on commas, trims, and drops
// empties. An omitted or empty `?locationIds` collapses to `undefined`, which the
// downstream RPC reads as "every location" (the aggregate-across-all default).
export class VariantStockQueryDto {
  @ApiPropertyOptional({
    type: String,
    example: 'default-warehouse,backup-store',
    description:
      'Comma-separated stock-location ids to scope the answer to; omit to aggregate across all locations',
  })
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    const tokens = (Array.isArray(value) ? value : [value])
      .flatMap((entry: unknown) => String(entry).split(','))
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    return tokens.length > 0 ? tokens : undefined;
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public locationIds?: string[];
}
