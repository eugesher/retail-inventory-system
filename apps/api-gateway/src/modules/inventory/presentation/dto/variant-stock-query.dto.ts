import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsString } from 'class-validator';

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
