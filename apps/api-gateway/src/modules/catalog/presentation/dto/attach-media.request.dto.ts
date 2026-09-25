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
