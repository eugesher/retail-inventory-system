import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { ReturnReasonCategoryEnum } from '@retail-inventory-system/contracts';

export class OpenReturnLineInputDto {
  @ApiProperty({ example: 1, minimum: 1, description: 'The placed order line id' })
  @IsInt()
  @Min(1)
  public orderLineId: number;

  @ApiProperty({ example: 1, minimum: 1, description: 'Units of that line being returned' })
  @IsInt()
  @Min(1)
  public quantity: number;
}

export class OpenReturnRequestDto {
  @ApiProperty({
    enum: ReturnReasonCategoryEnum,
    example: ReturnReasonCategoryEnum.DEFECTIVE,
    description: 'Why the buyer is returning the goods (coarse classification)',
  })
  @IsEnum(ReturnReasonCategoryEnum)
  public reasonCategory: ReturnReasonCategoryEnum;

  @ApiPropertyOptional({
    example: 'Item arrived with a cracked screen',
    description: 'Optional free-text buyer note',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public notes?: string;

  @ApiProperty({ type: [OpenReturnLineInputDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OpenReturnLineInputDto)
  public lines: OpenReturnLineInputDto[];
}
