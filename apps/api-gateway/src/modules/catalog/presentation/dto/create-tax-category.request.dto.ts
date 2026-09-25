import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { TAX_CATEGORY_CODE_PATTERN, TAX_CATEGORY_CODE_REGEX } from './validation.constants';

export class CreateTaxCategoryRequestDto {
  @ApiProperty({
    example: 'STANDARD',
    description: 'Stable UPPER_SNAKE_CASE identifier',
    pattern: TAX_CATEGORY_CODE_PATTERN,
    maxLength: 50,
  })
  @Matches(TAX_CATEGORY_CODE_REGEX, {
    message: `code must be UPPER_SNAKE_CASE (${TAX_CATEGORY_CODE_PATTERN})`,
  })
  @MaxLength(50)
  public code: string;

  @ApiProperty({ example: 'Standard rate', minLength: 1, maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  public name: string;

  @ApiPropertyOptional({ example: 'The default tax classification', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public description?: string;
}
