import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { MediaAssetTypeEnum, MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';

// Request body for `POST /api/catalog/media`. Attaches a new media asset to the
// owner identified by `(ownerType, ownerId)`. The owner is addressed by its
// BIGINT id (an operator attaching media already holds the product/variant id);
// the catalog use case probes that id against the matching table for existence
// (a miss → 404 `MEDIA_OWNER_NOT_FOUND`). `uri` is an OPAQUE, already-uploaded
// reference (`https://…` / `s3://…`) — the catalog neither uploads nor validates
// the scheme (ADR-029 §4); the edge guard only bounds its length. There is NO
// `sortOrder` field — attach always appends (`max(sort_order) + 1`); reordering is
// the separate `PATCH /api/catalog/media/reorder` operation.
export class AttachMediaRequestDto {
  @ApiProperty({ enum: MediaOwnerTypeEnum, example: MediaOwnerTypeEnum.PRODUCT })
  @IsEnum(MediaOwnerTypeEnum)
  public ownerType: MediaOwnerTypeEnum;

  @ApiProperty({ example: 1, description: 'BIGINT id of the owning product or product-variant' })
  @IsInt()
  @IsPositive()
  public ownerId: number;

  @ApiProperty({
    example: 'https://cdn.example.com/aeron/front.jpg',
    description: 'Opaque, already-uploaded media URI',
    minLength: 1,
    maxLength: 1024,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  public uri: string;

  @ApiProperty({ enum: MediaAssetTypeEnum, example: MediaAssetTypeEnum.IMAGE })
  @IsEnum(MediaAssetTypeEnum)
  public type: MediaAssetTypeEnum;

  @ApiPropertyOptional({ example: 'Front view of the Aeron chair', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public altText?: string;
}
