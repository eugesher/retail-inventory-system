import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { isNil } from 'lodash';

export class ProductStockGetQueryDto {
  @ApiPropertyOptional({
    description: 'JSON array of store IDs (optional)',
    example: '["head-warehouse","storage-alpha"]',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }: { value: string }) => {
    if (isNil(value)) {
      return undefined;
    }

    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  })
  public storageIds?: string[];
}
