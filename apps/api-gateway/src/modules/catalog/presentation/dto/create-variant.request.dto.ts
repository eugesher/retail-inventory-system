import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Millimetre bounding box. Non-negative integers; the catalog `Dimensions` VO
// re-validates downstream, this is the gateway's edge guard.
export class VariantDimensionsRequestDto {
  @ApiProperty({ example: 680, minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  public l: number;

  @ApiProperty({ example: 680, minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  public w: number;

  @ApiProperty({ example: 1145, minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  public h: number;
}

// Request body for `POST /api/catalog/products/:productId/variants`. The owning
// product is taken from the route param, not the body. `optionValues` is a
// free-form option map (e.g. `{ color: 'black', size: 'M' }`) — the catalog
// `OptionValues` VO enforces the non-empty-key/value invariant downstream.
export class CreateVariantRequestDto {
  @ApiProperty({ example: 'AERON-CHAIR-BLK-M', minLength: 1, maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  public sku: string;

  @ApiPropertyOptional({ example: '0123456789012', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public gtin?: string;

  @ApiProperty({
    example: { color: 'black', size: 'M' },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  public optionValues: Record<string, string>;

  @ApiPropertyOptional({ example: 14_500, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  public weightG?: number;

  @ApiPropertyOptional({ type: VariantDimensionsRequestDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => VariantDimensionsRequestDto)
  public dimensionsMm?: VariantDimensionsRequestDto;
}
